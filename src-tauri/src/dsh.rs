//! DSH (DeepSeek Harness) lifecycle: readiness probe, spawn, teardown.
//!
//! Launch strategy — path-free, official CLI first:
//!   1. `DSH_CMD` env override (optional `DSH_CWD`) replaces the whole chain;
//!      for source-checkout development (`pnpm dsh web` in the repo).
//!   2. `dsh web` — resolves a globally installed `dsh` from PATH (fastest;
//!      a missing command exits immediately and falls through).
//!   3. `npx @deepseek-ai/dsh web` — the official zero-install command
//!      (harness README "Run from npm"); only needs Node.js. The first run may
//!      download the package, so this candidate gets the long readiness window.
//! Each candidate has its own readiness window; early exit or timeout falls
//! through to the next, and every attempt is logged to dsh.log and reported in
//! the final error. The shell either *attaches* to a DSH already listening on
//! 127.0.0.1:3080 or *spawns* its own tree; only a DSH we spawned is torn down
//! on exit, an attached instance is left untouched.

use std::fs::OpenOptions;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const DSH_ORIGIN: &str = "http://127.0.0.1:3080";
const DSH_BASE: &str = "http://127.0.0.1:3080";

/// Overall readiness window for a single-command chain (DSH_CMD) and for the
/// npx candidate, whose first run downloads the package before booting.
const LONG_WINDOW: Duration = Duration::from_secs(120);
/// Window for the global-`dsh` candidate: boot is fast, and a missing command
/// exits immediately instead of consuming the window.
const GLOBAL_WINDOW: Duration = Duration::from_secs(30);
/// Interval between readiness probes.
const PROBE_INTERVAL: Duration = Duration::from_secs(1);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A DSH subprocess we spawned (and therefore own the lifecycle of).
struct DshInner {
    /// The cmd.exe shim; its grandchild node is the real 3080 host.
    child: Child,
    pid: u32,
}

/// Managed state holding the owned subprocess, if any.
/// `None` ⇒ attached mode (do not kill on exit).
pub struct DshState {
    inner: Mutex<Option<DshInner>>,
}

impl DshState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

/// One launch attempt in the candidate chain.
struct Candidate {
    /// Human label surfaced in `dsh-status` events and error reports.
    label: String,
    /// Shell command executed through `cmd /C`.
    cmd: String,
    /// Working directory for the child.
    cwd: String,
    /// How long this candidate may take to become ready.
    window: Duration,
}

/// Build the launch chain: `DSH_CMD` (with optional `DSH_CWD`) replaces it
/// entirely; otherwise global `dsh` first, the official npx command second.
/// The default working directory is the user profile — a neutral, writable
/// dir that never depends on a repo location.
fn candidates() -> Vec<Candidate> {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    if let Ok(cmd) = std::env::var("DSH_CMD") {
        if !cmd.trim().is_empty() {
            let cwd = std::env::var("DSH_CWD").unwrap_or(home);
            return vec![Candidate {
                label: "DSH_CMD".to_string(),
                cmd,
                cwd,
                window: LONG_WINDOW,
            }];
        }
    }
    let cwd = std::env::var("DSH_CWD").unwrap_or(home);
    vec![
        Candidate {
            label: "dsh web".to_string(),
            cmd: "dsh web".to_string(),
            cwd: cwd.clone(),
            window: GLOBAL_WINDOW,
        },
        Candidate {
            label: "npx --yes @deepseek-ai/dsh web".to_string(),
            cmd: "npx --yes @deepseek-ai/dsh web".to_string(),
            cwd,
            window: LONG_WINDOW,
        },
    ]
}

/// Probe 3080 once with a real `host.describe` RPC; true if DSH answers healthy.
/// A plain TCP connect is not enough — an open port is not necessarily DSH.
fn probe_ready_once() -> bool {
    let body = json!({
        "type": "client-request",
        "rpcId": Uuid::new_v4().to_string(),
        "method": "host.describe",
        "payload": {}
    });
    let response = ureq::post(&format!("{DSH_BASE}/api/host.describe"))
        // Match the host authority so the /api trust fence (Origin vs Host) passes.
        .set("Origin", DSH_ORIGIN)
        .timeout(Duration::from_secs(3))
        .send_json(body);
    match response {
        Ok(r) => match r.into_json::<Value>() {
            // Ready ⇔ the four-quadrant RPC envelope returns result.ok == true.
            Ok(v) => v.get("result").and_then(|x| x.get("ok")) == Some(&json!(true)),
            Err(_) => false,
        },
        Err(_) => false,
    }
}

/// Outcome of one candidate attempt.
enum Attempt {
    Ready,
    Failed(String),
}

/// Drive startup from a background thread. Emits `dsh-status` events:
/// `{status:"starting",method}` per attempt, then either
/// `{status:"ready",attached,method}` or `{status:"error",message}` with every
/// attempt's failure reason.
pub fn startup(app: AppHandle) {
    // Attach path: DSH already up — never spawn, never kill on exit.
    if probe_ready_once() {
        let _ = app.emit("dsh-status", json!({ "status": "ready", "attached": true }));
        return;
    }

    let mut failures: Vec<String> = Vec::new();
    for candidate in candidates() {
        let _ = app.emit(
            "dsh-status",
            json!({ "status": "starting", "method": candidate.label }),
        );
        match try_candidate(&app, &candidate) {
            Attempt::Ready => return,
            Attempt::Failed(reason) => {
                failures.push(format!("「{}」{}", candidate.label, reason));
            }
        }
    }
    let _ = app.emit(
        "dsh-status",
        json!({
            "status": "error",
            "message": format!("所有启动方式均失败:\n{}", failures.join("\n")),
        }),
    );
}

/// Spawn one candidate and poll until ready, early exit, or window expiry.
fn try_candidate(app: &AppHandle, candidate: &Candidate) -> Attempt {
    log_attempt(candidate);
    let mut child = match spawn_command(&candidate.cmd, &candidate.cwd) {
        Ok(c) => c,
        Err(e) => return Attempt::Failed(format!("无法启动({e})\n")),
    };
    let pid = child.id();
    let deadline = Instant::now() + candidate.window;
    loop {
        if probe_ready_once() {
            // Hand the owned child to managed state; teardown kills its tree.
            let state = app.state::<DshState>();
            *state.inner.lock().unwrap() = Some(DshInner { child, pid });
            let _ = app.emit(
                "dsh-status",
                json!({ "status": "ready", "attached": false, "method": candidate.label }),
            );
            return Attempt::Ready;
        }
        // A missing command exits immediately; surface that instead of
        // waiting out the whole window.
        match child.try_wait() {
            Ok(Some(status)) => return Attempt::Failed(format!("进程提前退出({status})\n")),
            Ok(None) => {}
            Err(e) => return Attempt::Failed(format!("无法查询子进程({e})\n")),
        }
        if Instant::now() >= deadline {
            kill_tree(pid);
            let _ = child.wait();
            return Attempt::Failed("就绪超时\n".to_string());
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
}

/// Re-arm after a failure: tear down any stale owned subprocess, then startup.
pub fn retry(app: AppHandle) {
    teardown(&app);
    let app2 = app.clone();
    std::thread::spawn(move || startup(app2));
}

/// Tear down the owned subprocess tree (if we spawned one). Safe to call from
/// attached mode — it is a no-op then.
pub fn teardown(app: &AppHandle) {
    let state = app.state::<DshState>();
    let mut guard = state.inner.lock().unwrap();
    if let Some(mut inner) = guard.take() {
        // Child::kill only reaps the cmd shim on Windows; taskkill /T kills the
        // whole node tree so no orphan keeps holding 3080.
        kill_tree(inner.pid);
        let _ = inner.child.wait();
    }
}

/// Append an attempt header to dsh.log so failures are attributable.
fn log_attempt(candidate: &Candidate) {
    use std::io::Write;
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "===== dsh-desktop 启动尝试: {} =====", candidate.label);
    }
}

/// Spawn a shell command detached, no console window, with stdout+stderr
/// appended to the log file under %LOCALAPPDATA%\dsh-desktop.
fn spawn_command(cmd: &str, cwd: &str) -> std::io::Result<Child> {
    let (stdout, stderr) = log_streams()?;
    let mut command = Command::new("cmd");
    // pnpm/npx/dsh are .cmd shims on Windows, so route through cmd /C; the
    // candidate command is a shell command string either way.
    command.arg("/C").arg(cmd).current_dir(cwd);
    command.stdout(stdout).stderr(stderr);
    apply_no_window(&mut command);
    command.spawn()
}

/// Two append handles to the same log file, one each for stdout/stderr.
fn log_streams() -> std::io::Result<(Stdio, Stdio)> {
    let path = log_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let stdout = OpenOptions::new().create(true).append(true).open(&path)?;
    let stderr = stdout.try_clone()?;
    Ok((Stdio::from(stdout), Stdio::from(stderr)))
}

fn log_path() -> std::path::PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(base)
        .join("dsh-desktop")
        .join("dsh.log")
}

/// Kill a process *tree* by root PID. `cmd /C …` → node is a grandchild; `/T`
/// walks the tree so nothing survives on 3080.
fn kill_tree(pid: u32) {
    let mut command = Command::new("taskkill");
    command.args(["/PID", &pid.to_string(), "/T", "/F"]);
    apply_no_window(&mut command);
    let _ = command.status();
}

#[cfg(windows)]
fn apply_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_no_window(_command: &mut Command) {}
