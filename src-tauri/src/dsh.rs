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
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const DSH_ORIGIN: &str = "http://127.0.0.1:3080";
const DSH_BASE: &str = "http://127.0.0.1:3080";

/// Readiness window for the single-command `DSH_CMD` chain.
const DSH_CMD_WINDOW: Duration = Duration::from_secs(120);
/// Readiness window for the npx candidate: its first run downloads the full
/// package (500+ dependencies) before booting, which took over two minutes
/// in practice — five minutes leaves headroom for slow links.
const NPX_FIRST_RUN_WINDOW: Duration = Duration::from_secs(300);
/// Window for the global-`dsh` candidate: boot is fast, and a missing command
/// exits immediately instead of consuming the window.
const GLOBAL_WINDOW: Duration = Duration::from_secs(30);
/// Interval between readiness probes.
const PROBE_INTERVAL: Duration = Duration::from_secs(1);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Local port the DSH web server listens on; also the anchor for finding an
/// attached instance's PID at restart time.
const DSH_PORT: u16 = 3080;

/// Boot-page URL captured at window build. Restart hands the webview back to
/// this page so the standard `dsh-status` event flow re-drives the handoff to
/// the fresh webchat, exactly like a cold start.
pub(crate) static BOOT_URL: OnceLock<String> = OnceLock::new();

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
/// dir that never depends on a repo location. A stale `DSH_CWD` pointing at a
/// deleted directory falls back to the profile dir instead of failing every
/// spawn with "directory name invalid" (os error 267).
fn candidates() -> Vec<Candidate> {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
    let cwd = std::env::var("DSH_CWD")
        .ok()
        .filter(|dir| Path::new(dir).is_dir())
        .unwrap_or_else(|| home.clone());
    if let Ok(cmd) = std::env::var("DSH_CMD") {
        if !cmd.trim().is_empty() {
            return vec![Candidate {
                label: "DSH_CMD".to_string(),
                cmd,
                cwd,
                window: DSH_CMD_WINDOW,
            }];
        }
    }
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
            window: NPX_FIRST_RUN_WINDOW,
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
        crate::menu::install(app);
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
            crate::menu::install(app.clone());
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

/// Tray "重启 DSH": hand the webview back to the boot page, kill whatever DSH
/// is on the port (owned *or* attached), wait out its death, then run the
/// normal startup chain — the boot page re-drives the webchat handoff from
/// there. Sessions are durable in `~/.dsh`, so nothing is lost.
pub fn restart(app: AppHandle) {
    std::thread::spawn(move || {
        show_boot_page(&app);
        teardown(&app);
        kill_port_listeners();
        // Wait for the old instance to stop answering so startup's attach
        // probe cannot latch onto the dying server and report ready.
        let deadline = Instant::now() + Duration::from_secs(10);
        while probe_ready_once() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500));
        }
        startup(app);
    });
}

/// Navigate the webview (currently the remote webchat) back to the app's boot
/// page, whose `dsh-status` listener takes over from here.
fn show_boot_page(app: &AppHandle) {
    if let (Some(url), Some(window)) = (BOOT_URL.get(), app.get_webview_window("main")) {
        let js = format!("window.location.replace('{}')", url.replace('\'', "\\'"));
        let _ = window.eval(&js);
    }
}

/// Kill any process still listening on the DSH port: an attached instance we
/// never spawned, or a straggler the owned-tree taskkill missed. Locale-safe:
/// matches the numeric local-address column, not the state text.
fn kill_port_listeners() {
    let mut command = Command::new("netstat");
    command.args(["-ano", "-p", "tcp"]);
    apply_no_window(&mut command);
    let Ok(output) = command.output() else {
        return;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let suffix = format!(":{DSH_PORT}");
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() >= 5
            && fields[0] == "TCP"
            && fields[1].ends_with(&suffix)
            && fields[4] != "0"
        {
            if let Ok(pid) = fields[4].parse::<u32>() {
                kill_tree(pid);
            }
        }
    }
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
