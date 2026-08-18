//! DSH (DeepSeek Harness) lifecycle: readiness probe, spawn, teardown.
//!
//! Launch strategy — local-first, download only on explicit consent:
//!   1. `DSH_CMD` env override (optional `DSH_CWD`) replaces the whole chain;
//!      for source-checkout development (`pnpm dsh web` in the repo).
//!   2. `dsh web` — a globally installed `dsh` found on PATH (npm/pnpm -g).
//!   3. Project-local install — `node_modules\.bin\dsh.cmd` searched in the
//!      exe's directory, the working directory, then the user profile.
//!   4. `npx @deepseek-ai/dsh web` — downloads the package, so it runs
//!      automatically only after the user picked "download" once (persisted
//!      in settings.json); otherwise a "notfound" event asks the user to
//!      choose download or exit.
//! Each candidate has its own readiness window; early exit or timeout falls
//! through to the next, and every attempt is logged to dsh.log and reported in
//! the final error. The shell either *attaches* to a DSH already listening on
//! 127.0.0.1:3080 or *spawns* its own tree; only a DSH we spawned is torn down
//! on exit, an attached instance is left untouched.

use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
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
    pid: u32,
}

/// True while teardown/restart intentionally kill the owned child — the
/// supervisor watcher must not treat those exits as crashes.
static INTENTIONAL_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Consecutive short-lived respawns; the crash-loop guard's trip counter.
static QUICK_DEATHS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

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

/// Build the launch chain, local-first. `DSH_CMD` (with optional `DSH_CWD`)
/// leads but no longer replaces the chain — a stale override falls through to
/// the saved custom path, the PATH-global `dsh` (found via `where dsh`,
/// covering the npm global `dsh`/`dsh.cmd` pair), a project-local
/// `node_modules\.bin\dsh.cmd`, and the npx download the user consented to.
/// An empty chain means "no local DSH" — startup reports `notfound` and the
/// boot page asks the user.
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
    let mut list = Vec::new();
    if let Ok(cmd) = std::env::var("DSH_CMD") {
        if !cmd.trim().is_empty() {
            list.push(Candidate {
                label: "DSH_CMD".to_string(),
                cmd,
                cwd: cwd.clone(),
                window: DSH_CMD_WINDOW,
            });
        }
    }
    if let Some(path) = custom_dsh_path() {
        list.push(Candidate {
            label: format!("自定义路径({path})"),
            cmd: format!("\"{path}\" web"),
            cwd: cwd.clone(),
            window: GLOBAL_WINDOW,
        });
    }
    if dsh_on_path() {
        list.push(Candidate {
            label: "dsh web".to_string(),
            cmd: "dsh web".to_string(),
            cwd: cwd.clone(),
            window: GLOBAL_WINDOW,
        });
    }
    if let Some((shim, root)) = find_local_install() {
        list.push(Candidate {
            label: format!("本地安装({})", root.display()),
            cmd: format!("\"{}\" web", shim.display()),
            cwd: root.display().to_string(),
            window: GLOBAL_WINDOW,
        });
    }
    if prefer_npx() {
        list.push(npx_candidate(cwd));
    }
    list
}

/// Shell command string for invoking the dsh CLI with a subcommand (e.g.
/// `plugin --profile web add pkg@ver`), resolved through the same local-first
/// discovery as the launch chain. DSH_CMD is deliberately skipped: it is a
/// raw command string that may carry its own `web` argument and cannot be
/// reliably re-targeted. `None` when no usable dsh exists.
pub(crate) fn dsh_cli_command(sub: &str) -> Option<String> {
    if let Some(path) = custom_dsh_path() {
        return Some(format!("\"{path}\" {sub}"));
    }
    if dsh_on_path() {
        return Some(format!("dsh {sub}"));
    }
    if let Some((shim, _root)) = find_local_install() {
        return Some(format!("\"{}\" {sub}", shim.display()));
    }
    None
}

/// The official zero-install command; its first run downloads 500+
/// dependencies before booting.
fn npx_candidate(cwd: String) -> Candidate {
    Candidate {
        label: "npx --yes @deepseek-ai/dsh web".to_string(),
        cmd: "npx --yes @deepseek-ai/dsh web".to_string(),
        cwd,
        window: NPX_FIRST_RUN_WINDOW,
    }
}

/// True if a `dsh` command (npm/pnpm global install) resolves on PATH.
fn dsh_on_path() -> bool {
    let mut command = Command::new("where");
    command.arg("dsh");
    apply_no_window(&mut command);
    command.status().map(|s| s.success()).unwrap_or(false)
}

/// Directories searched for a project-local DSH install
/// (`node_modules\.bin\dsh.cmd`), in order: next to the exe (the "download
/// the exe, `pnpm add` beside it" setup), the working directory, then the
/// user profile. Returns the shim and its owning root.
fn find_local_install() -> Option<(PathBuf, PathBuf)> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        if !roots.contains(&home) {
            roots.push(home);
        }
    }
    roots.into_iter().find_map(|root| {
        let shim = root.join("node_modules").join(".bin").join("dsh.cmd");
        shim.is_file().then_some((shim, root))
    })
}

/// User preferences persisted beside dsh.log: `preferNpx` set once the user
/// picks "download" (later cold starts run npx directly), and `customDshPath`
/// a user-entered dsh location that outlives the notfound dialog. Best-effort
/// — an unreadable file just reads empty.
fn settings_path() -> PathBuf {
    log_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("settings.json")
}

fn read_settings() -> Value {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({}))
}

fn write_settings(map: Value) {
    let _ = std::fs::write(settings_path(), serde_json::to_string(&map).unwrap_or_default());
}

fn prefer_npx() -> bool {
    read_settings()
        .get("preferNpx")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
}

fn save_prefer_npx(value: bool) {
    let mut settings = read_settings();
    settings["preferNpx"] = json!(value);
    write_settings(settings);
}

/// User-entered dsh executable (dsh.cmd/dsh.exe) saved from the notfound
/// dialog; `None` when unset or the file no longer exists (self-healing).
fn custom_dsh_path() -> Option<String> {
    read_settings()
        .get("customDshPath")
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .filter(|path| Path::new(path).is_file())
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


/// Emit `ready` repeatedly for a short window instead of once. The boot page's
/// listener registers only after the embedded webview finishes loading, which
/// races the fast local readiness probe — a one-shot emit can be missed and
/// leave the window stuck on the boot spinner.
fn emit_ready(app: &AppHandle, attached: bool, method: Option<String>) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        for _ in 0..10 {
            let mut payload = json!({ "status": "ready", "attached": attached });
            if let Some(m) = &method {
                payload["method"] = json!(m);
            }
            let _ = app2.emit("dsh-status", payload);
            std::thread::sleep(Duration::from_millis(400));
        }
    });
}

/// Drive startup from a background thread. Emits `dsh-status` events:
/// `{status:"starting",method}` per attempt, then either
/// `{status:"ready",attached,method}` or `{status:"error",message}` with every
/// attempt's failure reason.
pub fn startup(app: AppHandle) {
    // Attach path: DSH already up — never spawn, never kill on exit.
    if probe_ready_once() {
        emit_ready(&app, true, None);
        crate::menu::install(app);
        return;
    }

    let mut failures: Vec<String> = Vec::new();
    let chain = candidates();
    // No local DSH and no consented download: hand the choice to the user
    // instead of silently pulling 500+ dependencies.
    if chain.is_empty() {
        let _ = app.emit("dsh-status", json!({ "status": "notfound" }));
        return;
    }
    for candidate in chain {
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
            // The state keeps only the pid (for teardown's tree kill); the
            // Child handle moves to the supervisor thread, which reaps the
            // process and reacts to unexpected exits.
            let state = app.state::<DshState>();
            *state.inner.lock().unwrap() = Some(DshInner { pid });
            INTENTIONAL_STOP.store(false, std::sync::atomic::Ordering::Relaxed);
            emit_ready(app, false, Some(candidate.label.clone()));
            crate::menu::install(app.clone());
            let app2 = app.clone();
            std::thread::spawn(move || supervise_child(app2, child, pid, Instant::now()));
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

/// One supervision event line to dsh.log.
fn supervision_log(line: &str) {
    use std::io::Write;
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[dsh-desktop] {line}");
    }
}

/// First `where <name>` hit, windowless.
fn where_first(name: &str) -> Option<String> {
    let mut command = Command::new("where");
    command.arg(name);
    apply_no_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
}

/// One captured run of a program (`node --version` style).
fn run_capture(program: &str, args: &[&str]) -> Option<String> {
    use std::io::Read;
    let mut child = Command::new(program)
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    let _ = child.wait();
    let trimmed = out.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Pid currently listening on the DSH port.
fn port_listener_pid() -> Option<u32> {
    let mut command = Command::new("netstat");
    command.args(["-ano", "-p", "tcp"]);
    apply_no_window(&mut command);
    let output = command.output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let suffix = format!(":{DSH_PORT}");
    text.lines().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        (fields.len() >= 5 && fields[0] == "TCP" && fields[1].ends_with(&suffix) && fields[4] != "0")
            .then(|| fields[4].parse::<u32>().ok())
            .flatten()
    })
}

/// Who owns the DSH port: pid, command line, and whether the parent chain
/// leads back to this app (ours) or to an external instance. PowerShell does
/// the chain walk; JSON keeps the boundary parse-free.
fn port_owner_info() -> Option<Value> {
    let pid = port_listener_pid()?;
    let script = format!(
        "$p = Get-CimInstance Win32_Process -Filter 'ProcessId={pid}'; \
         if ($null -eq $p) {{ exit 1 }}; \
         $names = @($p.Name); $cur = $p; $owned = $false; \
         for ($i = 0; $i -lt 5 -and $null -ne $cur; $i++) {{ \
           if ($cur.Name -eq 'dsh-desktop-windowos.exe') {{ $owned = $true; break }}; \
           $cur = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $cur.ParentProcessId); \
           if ($null -ne $cur) {{ $names += $cur.Name }} \
         }}; \
         [pscustomobject]@{{ pid = $p.ProcessId; cmd = $p.CommandLine; chain = ($names -join ' <- '); owned = $owned }} | ConvertTo-Json -Compress"
    );
    let output = run_capture("powershell", &["-NoProfile", "-Command", &script])?;
    serde_json::from_str(&output).ok()
}

/// Plugin package versions installed in the user's web profile.
fn profile_plugin_versions() -> Value {
    let read_version = |name: &str| -> Value {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        let manifest = Path::new(&home)
            .join(".dsh")
            .join("profiles")
            .join("web")
            .join("node_modules")
            .join(name)
            .join("package.json");
        std::fs::read_to_string(manifest)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|doc| doc["version"].as_str().map(str::to_string))
            .map(Value::String)
            .unwrap_or(Value::Null)
    };
    json!({
        "dshDesktopPlugin": read_version("dsh-desktop-plugin"),
        "dshmarket": read_version("dshmarket"),
    })
}

/// Last `n` lines of the shared shell log for the console pane.
fn log_tail(n: usize) -> Vec<String> {
    std::fs::read_to_string(log_path())
        .map(|text| {
            let lines: Vec<&str> = text.lines().collect();
            let start = lines.len().saturating_sub(n);
            lines[start..].iter().map(|l| l.to_string()).collect()
        })
        .unwrap_or_default()
}

/// Environment facts for the env panel, modelled on Comfy Desktop's
/// StatusFactPanel data shape: every field is gathered independently and
/// degrades to null — the panel never hangs on a probe.
pub fn env_info(app: &AppHandle) -> Value {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let settings = read_settings();
    let install_dir = tauri::utils::platform::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.display().to_string()));
    json!({
        "app": {
            "version": app.package_info().version.to_string(),
            "installDir": install_dir,
        },
        "dsh": {
            "portAnswering": probe_ready_once(),
            "owner": port_owner_info(),
            "dshCmd": std::env::var("DSH_CMD").ok().filter(|v| !v.trim().is_empty()),
            "dshCwd": std::env::var("DSH_CWD").ok().filter(|v| !v.trim().is_empty()),
            "customPath": settings.get("customDshPath").and_then(Value::as_str),
            "whereDsh": where_first("dsh"),
            "localInstall": find_local_install().map(|(shim, root)| json!({ "shim": shim.display().to_string(), "root": root.display().to_string() })),
            "preferNpx": prefer_npx(),
        },
        "node": {
            "path": where_first("node"),
            "version": run_capture("node", &["--version"]),
        },
        "plugins": profile_plugin_versions(),
        "profileDir": Path::new(&home).join(".dsh").join("profiles").join("web").display().to_string(),
        "logTail": log_tail(25),
    })
}

/// Watch the owned DSH child and heal the stack when it dies unexpectedly
/// (a DSH crash, or dshmarket's self-restart killing the host for an update).
/// Expected exits (teardown / tray restart) set INTENTIONAL_STOP first.
fn supervise_child(app: AppHandle, mut child: Child, pid: u32, spawned_at: Instant) {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(_) => return,
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let _ = child.wait(); // reap
    if INTENTIONAL_STOP.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    supervision_log(&format!("supervised dsh web (pid {pid}) exited unexpectedly; healing"));
    // Crash-loop guard: three consecutive children that lived under 30s stop
    // the auto-respawn and surface an error instead of spinning forever.
    if spawned_at.elapsed() < Duration::from_secs(30) {
        let deaths = QUICK_DEATHS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        if deaths >= 3 {
            supervision_log(&format!("supervised dsh web (pid {pid}) crashed 3x quickly; auto-respawn stopped"));
            let _ = app.emit(
                "dsh-status",
                json!({ "status": "error", "message": "DSH 反复意外退出,已停止自动重启——详见 dsh.log,可稍后用托盘「重启 dsh web(后端)」重试" }),
            );
            show_boot_page(&app);
            return;
        }
    } else {
        QUICK_DEATHS.store(0, std::sync::atomic::Ordering::SeqCst);
    }
    // dshmarket's restart helper races a replacement onto 3080 ~1.5s after
    // the host dies; that replacement is an orphan outside our supervision
    // (a later quit would not stop it), so let it land, clear the port, and
    // spawn our own child instead.
    std::thread::sleep(Duration::from_millis(2500));
    kill_port_listeners();
    let deadline = Instant::now() + Duration::from_secs(10);
    while probe_ready_once() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(500));
    }
    startup(app.clone());
    if probe_ready_once() {
        // The window usually still holds the dead webchat page — force a
        // reload so it reattaches to the fresh host.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(&format!("window.location.replace('{DSH_BASE}/')"));
        }
    } else {
        show_boot_page(&app);
    }
}

/// Frontend "使用此路径启动" from the notfound dialog: remember the
/// user-entered dsh executable and retry startup with it leading the chain.
/// Returns Err with a user-facing message when the path does not exist.
pub fn set_custom_path(app: &AppHandle, raw: String) -> Result<(), String> {
    let path = raw.trim().trim_matches('"').to_string();
    if path.is_empty() {
        return Err("路径不能为空".to_string());
    }
    if !Path::new(&path).is_file() {
        return Err(format!("找不到文件:{path}(需要 dsh.cmd 或 dsh.exe 的完整路径)"));
    }
    let mut settings = read_settings();
    settings["customDshPath"] = json!(path);
    write_settings(settings);
    teardown(app);
    let app2 = app.clone();
    std::thread::spawn(move || startup(app2));
    Ok(())
}

/// The two npm registries the one-click installer may use, probed in
/// parallel at boot; the faster becomes the default and the UI offers the
/// other as an explicit choice.
pub const REGISTRY_NPMJS: &str = "https://registry.npmjs.org";
pub const REGISTRY_NPMMIRROR: &str = "https://registry.npmmirror.com";

/// Time one GET of the package's /latest metadata in ms; None when the
/// registry is unreachable within 4s.
fn probe_registry_ms(base: &str) -> Option<u128> {
    let start = std::time::Instant::now();
    let reached = ureq::get(&format!("{base}/@deepseek-ai/dsh/latest"))
        .timeout(Duration::from_secs(4))
        .call()
        .is_ok();
    reached.then(|| start.elapsed().as_millis())
}

/// Probe both registries in parallel (bounded by one timeout window). The
/// JSON feeds the boot page's source chooser; `fastest` is null when both
/// are unreachable (the UI then falls back to the plain npm default).
pub fn npm_probe() -> Value {
    let npmjs = std::thread::spawn(|| probe_registry_ms(REGISTRY_NPMJS));
    let mirror = std::thread::spawn(|| probe_registry_ms(REGISTRY_NPMMIRROR));
    let npmjs_ms = npmjs.join().unwrap_or(None);
    let mirror_ms = mirror.join().unwrap_or(None);
    let fastest = match (npmjs_ms, mirror_ms) {
        (Some(a), Some(b)) => Some(if a <= b { "npmjs" } else { "npmmirror" }),
        (Some(_), None) => Some("npmjs"),
        (None, Some(_)) => Some("npmmirror"),
        (None, None) => None,
    };
    json!({ "npmjsMs": npmjs_ms, "npmmirrorMs": mirror_ms, "fastest": fastest })
}

/// Frontend "一键全局安装并启动": run `npm install -g @deepseek-ai/dsh`
/// (optionally pinned to one of the two probed registries) and retry
/// startup — afterwards `where dsh` leads the chain permanently. The
/// install (500+ packages) can take minutes; it runs on its own thread and
/// reports progress through the usual `dsh-status` events.
pub fn install_global_npm(app: AppHandle, registry: Option<&str>) {
    // Whitelist: only the two probed registries may enter the command line.
    // Owned because the install thread outlives this call.
    let url = registry
        .filter(|u| *u == REGISTRY_NPMJS || *u == REGISTRY_NPMMIRROR)
        .map(str::to_string);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let (label, spec) = match url {
            Some(u) if u == REGISTRY_NPMMIRROR => (
                "npm 全局安装中(国内镜像,约 1-3 分钟)",
                format!("npm install -g @deepseek-ai/dsh --registry={u}"),
            ),
            Some(u) => (
                "npm 全局安装中(官方源,约 1-3 分钟)",
                format!("npm install -g @deepseek-ai/dsh --registry={u}"),
            ),
            None => (
                "npm 全局安装中(约 1-3 分钟)",
                "npm install -g @deepseek-ai/dsh".to_string(),
            ),
        };
        let _ = app2.emit(
            "dsh-status",
            json!({ "status": "starting", "method": label }),
        );
        let mut command = Command::new("cmd");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.raw_arg(format!("/S /C \"{spec}\""));
        }
        #[cfg(not(windows))]
        {
            command.arg("-c").arg(&spec);
        }
        command
            .current_dir(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string()))
            .stdout(log_stdio())
            .stderr(null_stdio());
        apply_no_window(&mut command);
        match command.output() {
            Ok(output) if output.status.success() => {
                retry(app2);
            }
            Ok(output) => {
                let _ = app2.emit(
                    "dsh-status",
                    json!({
                        "status": "error",
                        "message": format!(
                            "npm 全局安装失败(退出码 {})。详见日志 {}\\dsh.log,或改用「下载并启动(npx)」/手动路径。",
                            output.status.code().unwrap_or(-1),
                            std::env::var("LOCALAPPDATA").unwrap_or_default(),
                        ),
                    }),
                );
            }
            Err(error) => {
                let _ = app2.emit(
                    "dsh-status",
                    json!({ "status": "error", "message": format!("无法运行 npm(需要已安装 Node.js):{error}") }),
                );
            }
        }
    });
}

/// Re-arm after a failure: tear down any stale owned subprocess, then startup.
pub fn retry(app: AppHandle) {
    teardown(&app);
    let app2 = app.clone();
    std::thread::spawn(move || startup(app2));
}

/// Frontend "下载并启动" after `notfound` (or as an error fallback): persist the
/// consent so future cold starts include the npx candidate automatically, then
/// run exactly that candidate now.
pub fn download_and_start(app: AppHandle) {
    save_prefer_npx(true);
    teardown(&app);
    let app2 = app.clone();
    std::thread::spawn(move || {
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
        let cwd = std::env::var("DSH_CWD")
            .ok()
            .filter(|dir| Path::new(dir).is_dir())
            .unwrap_or(home);
        let candidate = npx_candidate(cwd);
        let _ = app2.emit(
            "dsh-status",
            json!({ "status": "starting", "method": candidate.label }),
        );
        if let Attempt::Failed(reason) = try_candidate(&app2, &candidate) {
            let _ = app2.emit(
                "dsh-status",
                json!({
                    "status": "error",
                    "message": format!("「{}」{}", candidate.label, reason),
                }),
            );
        }
    });
}

/// Tray "重启 DSH": hand the webview back to the boot page, kill whatever DSH
/// is on the port (owned *or* attached), wait out its death, then run the
/// normal startup chain — the boot page re-drives the webchat handoff from
/// there. Sessions are durable in `~/.dsh`, so nothing is lost.
pub fn restart(app: AppHandle) {
    // Pop the window first so a restart triggered while hidden in the tray is
    // visibly underway instead of looking like a no-op.
    crate::show_main_window(&app);
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
        startup(app.clone());
        ensure_webchat_shown(&app);
    });
}

/// After a restart, the boot page normally hands the window to the fresh
/// webchat on its `ready` listener. If that handoff is lost — the page load
/// missed the event, or the captured boot URL was unusable — the window sits
/// on a dead page while DSH is up. Poll briefly for the handoff, then force
/// the navigation.
fn ensure_webchat_shown(app: &AppHandle) {
    if !probe_ready_once() {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let on_webchat = || {
        window
            .url()
            .map(|u| u.host_str() == Some("127.0.0.1") && u.port() == Some(DSH_PORT))
            .unwrap_or(false)
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while !on_webchat() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
    }
    if !on_webchat() {
        let _ = window.eval(&format!(
            "window.location.replace('{DSH_BASE}/')"
        ));
    }
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
    INTENTIONAL_STOP.store(true, std::sync::atomic::Ordering::Relaxed);
    let state = app.state::<DshState>();
    let mut guard = state.inner.lock().unwrap();
    if let Some(inner) = guard.take() {
        // Child::kill only reaps the cmd shim on Windows; taskkill /T kills the
        // whole node tree so no orphan keeps holding 3080. The supervisor
        // thread reaps the Child and stays quiet (intentional stop).
        kill_tree(inner.pid);
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
    // candidate command is a shell command string either way. Pass it via
    // `raw_arg` as `/S /C "…"`: std's automatic quoting would re-wrap the
    // whole string and backslash-escape the inner quotes around
    // space-containing paths, which cmd then misparses — `/S` strips only
    // the outermost quote pair, preserving our inner quotes verbatim.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.raw_arg(format!("/S /C \"{cmd}\""));
    }
    #[cfg(not(windows))]
    {
        command.arg("/C").arg(cmd);
    }
    command.current_dir(cwd);
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

/// One append handle to the log (stdout only).
fn log_stdio() -> Stdio {
    match log_streams() {
        Ok((stdout, _)) => stdout,
        Err(_) => Stdio::null(),
    }
}

fn null_stdio() -> Stdio {
    Stdio::null()
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
