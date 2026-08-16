//! App self-update: on launch, compare the running version with the latest
//! GitHub Release, swap the exe aside when one exists, and narrate progress
//! to the boot page's version pill via `app-update` events.
//!
//! Runs on its own thread parallel to the DSH lifecycle; every failure is
//! silent (logged only) so a flaky network never blocks startup.

use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

use crate::dsh;

const REPO_SLUG: &str = "RAFOLIE/dsh-desktop-windowos";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PLUGIN_NAME: &str = "dsh-desktop-plugin";

/// Re-entry guard for the tray-triggered check (menu spam runs one check).
static CHECK_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Fire-and-forget Windows toast; mirrors monitor.rs's notification recipe.
fn toast(text: &str) {
    use tauri_winrt_notification::{Duration as ToastDuration, Toast};
    let _ = Toast::new(crate::TOAST_AUMID)
        .title("DSH 桌面端")
        .text1(text)
        .duration(ToastDuration::Short)
        .show();
}

/// Compare dotted numeric triples; positive when `a > b`.
fn compare_versions(a: &str, b: &str) -> i32 {
    let pa = a.split('.').map(|x| x.parse::<i64>().unwrap_or(0));
    let pb = b.split('.').map(|x| x.parse::<i64>().unwrap_or(0));
    let pa: Vec<i64> = pa.collect();
    let pb: Vec<i64> = pb.collect();
    for i in 0..pa.len().max(pb.len()) {
        let d = (pa.get(i).copied().unwrap_or(0)) - (pb.get(i).copied().unwrap_or(0));
        if d != 0 {
            return d.signum() as i32;
        }
    }
    0
}

/// Extract `<x.y.z>` from a `dsh-desktop-windowos-v<x.y.z>.exe` asset name.
fn parse_asset_version(name: &str) -> Option<&str> {
    let version = name
        .strip_prefix("dsh-desktop-windowos-v")?
        .strip_suffix(".exe")?;
    let ok = !version.is_empty()
        && version.split('.').count() == 3
        && version
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.');
    ok.then_some(version)
}

/// Proxy candidates for the asset-download fallback: an explicit environment
/// override first, then the common local proxy ports (GitHub's release CDN is
/// intermittently unreachable directly on this network while the local proxy
/// sails through).
fn proxy_candidates() -> Vec<String> {
    let mut list = Vec::new();
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() && !list.contains(&value) {
                list.push(value);
            }
        }
    }
    for port in ["7890", "7891"] {
        let value = format!("http://127.0.0.1:{port}");
        if !list.contains(&value) {
            list.push(value);
        }
    }
    list
}

/// 1-second TCP probe so dead proxy ports don't burn curl timeouts.
fn proxy_alive(proxy: &str) -> bool {
    let authority = proxy
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    let Some((host, port)) = authority.rsplit_once(':') else {
        return false;
    };
    let Ok(port) = port.parse::<u16>() else {
        return false;
    };
    use std::net::ToSocketAddrs;
    let Ok(mut addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    match addrs.next() {
        Some(addr) => std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(1)).is_ok(),
        None => false,
    }
}

/// One curl run; `proxy` adds `-x` when set.
fn curl_to(url: &str, dest: &Path, proxy: Option<&str>) -> std::io::Result<()> {
    let mut command = std::process::Command::new("curl");
    command
        .args([
            "--silent",
            "--show-error",
            "--location",
            "--fail",
            "--retry",
            "2",
            "--max-time",
            "150",
            "--user-agent",
            "dsh-desktop-windowos",
            "--output",
        ])
        .arg(dest)
        .arg(url);
    if let Some(proxy) = proxy {
        command.arg("-x").arg(proxy);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let status = command.status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("curl exit {status} for {url}")))
    }
}

/// Download a release asset with system curl, direct first and then through
/// every reachable proxy candidate — a direct-only download fails silently
/// for the user whenever GitHub's CDN is blocked on the current network.
fn download_with_curl(url: &str, dest: &Path) -> std::io::Result<()> {
    if curl_to(url, dest, None).is_ok() {
        return Ok(());
    }
    for proxy in proxy_candidates() {
        if !proxy_alive(&proxy) {
            continue;
        }
        log_line(&format!(
            "[dsh-desktop] direct asset download failed; retrying via proxy {proxy}"
        ));
        if curl_to(url, dest, Some(&proxy)).is_ok() {
            return Ok(());
        }
    }
    Err(std::io::Error::other(format!(
        "all download attempts failed for {url}"
    )))
}

/// Relaunch the app onto the freshly swapped exe. A detached helper waits for
/// this process to exit (releasing the single-instance lock), then starts the
/// new exe. The exit skips DSH teardown on purpose: a running webchat backend
/// stays up and the new instance attaches to it instead of respawning.
fn relaunch_app(exe: &Path) {
    let mut command = std::process::Command::new("cmd");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `start "" "path"` is the quote-proof way to launch a path with
        // spaces; after /S strips the outer quotes the helper reads:
        //   timeout /t 3 /nobreak >nul & start "" "C:\...\app.exe"
        command.raw_arg(format!(
            "/S /C \"timeout /t 3 /nobreak >nul & start \"\" \"{}\"\"",
            exe.display()
        ));
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        command
            .arg("-c")
            .arg(format!("sleep 3 && '{}'", exe.display()));
    }
    match command.spawn() {
        Ok(_) => log_line("[dsh-desktop] relaunch helper armed (starts the new exe in ~3s)"),
        Err(e) => log_line(&format!(
            "[dsh-desktop] relaunch helper failed ({e}); the new version activates on next manual launch"
        )),
    }
}

/// The whole launch-time flow; each step narrates to the boot page. When
/// `on_demand` (tray "检查前端更新"), outcomes additionally surface as
/// Windows toasts because the boot page — the usual narrator — is usually
/// gone by then (the window sits on the webchat).
fn run_check(app: &AppHandle, on_demand: bool) -> Result<(), String> {
    let current = app.package_info().version.to_string();
    let narrate = |payload: serde_json::Value| {
        let _ = app.emit("app-update", payload);
    };

    // The title bar is the only place our identity survives the handoff to
    // the native webchat, so it carries the version from the very start.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(&format!("DeepSeek Harness v{current}"));
    }

    narrate(json!({ "state": "checking" }));
    let body: serde_json::Value = ureq::get(&format!(
        "https://api.github.com/repos/{REPO_SLUG}/releases/latest"
    ))
    .set("User-Agent", "dsh-desktop-windowos")
    .set("Accept", "application/vnd.github+json")
    .timeout(Duration::from_secs(5))
    .call()
    .map_err(|e| format!("github api: {e}"))?
    .into_json()
    .map_err(|e| format!("github json: {e}"))?;

    let mut latest: Option<(String, String)> = None;
    if let Some(assets) = body["assets"].as_array() {
        for asset in assets {
            let name = asset["name"].as_str().unwrap_or_default();
            let url = asset["browser_download_url"].as_str().unwrap_or_default();
            if let Some(version) = parse_asset_version(name) {
                latest = Some((version.to_string(), url.to_string()));
                break;
            }
        }
    }
    let Some((to_version, url)) = latest else {
        narrate(json!({ "state": "failed", "message": "latest release has no versioned exe asset" }));
        return Ok(());
    };
    if compare_versions(&to_version, &current) <= 0 {
        narrate(json!({ "state": "none" }));
        if on_demand {
            toast(&format!("前端已是最新版本 v{current}"));
        }
        sync_plugin_packages(&current);
        return Ok(());
    }

    narrate(json!({ "state": "downloading", "from": current, "to": to_version }));
    if on_demand {
        toast(&format!("正在下载前端 v{to_version}…"));
    }
    let exe = tauri::utils::platform::current_exe().map_err(|e| format!("current exe: {e}"))?;
    let tmp = std::env::temp_dir().join(format!(
        "dsh-desktop-update-{}-{to_version}.exe",
        std::process::id()
    ));
    download_with_curl(&url, &tmp).map_err(|e| format!("download: {e}"))?;

    // Rename-aside swap: safe on a running exe on Windows. If the copy fails
    // after the rename, roll back so the install is never left without an exe.
    let old = exe.with_extension("exe.old");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| format!("rename aside: {e}"))?;
    if let Err(e) = std::fs::copy(&tmp, &exe) {
        let _ = std::fs::rename(&old, &exe);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("copy in place: {e}"));
    }
    let _ = std::fs::remove_file(&tmp);

    narrate(json!({ "state": "done", "from": current, "to": to_version }));
    if on_demand {
        toast(&format!("已更新到 v{to_version},正在重启…"));
    }
    // The exe is on the new version now; bring the npm-installed plugin
    // package onto the same line so the market stops offering (and pnpm's
    // fresh-release hold keeps rejecting) an update.
    sync_plugin_packages(&to_version);
    // The running process still has the old code (e.g. the window's drag-drop
    // settings were fixed at build time), so restart onto the new exe. The
    // pause lets the pill's green check land first; updates only ever happen
    // at launch, so this never interrupts an ongoing chat.
    log_line(&format!(
        "[dsh-desktop] exe updated {current} -> {to_version}; restarting onto the new build"
    ));
    std::thread::sleep(Duration::from_secs(2));
    relaunch_app(&exe);
    app.exit(0);
    Ok(())
}

/// Append one line to the shared shell log beside the exe updater's output.
fn log_line(line: &str) {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    let path = std::path::PathBuf::from(base)
        .join("dsh-desktop")
        .join("dsh.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        use std::io::Write;
        let _ = writeln!(file, "{line}");
    }
}

/// Run one shell command hidden, with CI=true (pnpm blocks forever on an
/// interactive prompt without a TTY), logging a one-line outcome plus the
/// output tail to dsh.log.
fn run_logged(cmd: &str) -> bool {
    let mut command = std::process::Command::new("cmd");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.raw_arg(format!("/S /C \"{cmd}\""));
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        command.arg("/C").arg(cmd);
    }
    command
        .env("CI", "true")
        .current_dir(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string()));
    match command.output() {
        Ok(output) => {
            let ok = output.status.success();
            let tail = String::from_utf8_lossy(&output.stdout);
            let tail = tail.chars().rev().take(240).collect::<Vec<_>>();
            let tail: String = tail.into_iter().rev().collect();
            let err_tail = String::from_utf8_lossy(&output.stderr);
            let err_tail = err_tail.chars().rev().take(240).collect::<Vec<_>>();
            let err_tail: String = err_tail.into_iter().rev().collect();
            log_line(&format!(
                "[dsh-desktop] plugin sync {} (exit {}): {}{}",
                if ok { "ok" } else { "FAILED" },
                output.status.code().unwrap_or(-1),
                tail.trim_end(),
                if err_tail.trim().is_empty() { String::new() } else { format!(" | {err_tail}") },
            ));
            ok
        }
        Err(e) => {
            log_line(&format!("[dsh-desktop] plugin sync spawn failed: {e}"));
            false
        }
    }
}

/// Keep the npm-installed plugin package on the app's version line: for every
/// DSH profile that ALREADY has `{PLUGIN_NAME}` installed, pin it to `target`
/// via `dsh plugin add` with the one-shot pnpm fresh-release bypass — the
/// same override dshmarket's "update now" uses. Profiles without the plugin
/// are never touched (no silent installs), and steady state (versions equal)
/// spawns nothing at all.
fn sync_plugin_packages(target: &str) {
    let home = std::env::var("DSH_HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let profiles_root = Path::new(&home).join(".dsh").join("profiles");
    let Ok(dirs) = std::fs::read_dir(&profiles_root) else {
        return;
    };
    for entry in dirs.flatten() {
        let profile = entry.file_name().to_string_lossy().to_string();
        let manifest = entry
            .path()
            .join("node_modules")
            .join(PLUGIN_NAME)
            .join("package.json");
        let Ok(text) = std::fs::read_to_string(&manifest) else {
            continue;
        };
        let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let installed = doc["version"].as_str().unwrap_or_default();
        if installed == target {
            continue;
        }
        log_line(&format!(
            "[dsh-desktop] syncing {PLUGIN_NAME} {installed} -> {target} in profile {profile}"
        ));
        let sub = format!("plugin --profile {profile} add {PLUGIN_NAME}@{target} --config.minimumReleaseAge=0");
        match dsh::dsh_cli_command(&sub) {
            Some(cmd) => {
                run_logged(&cmd);
            }
            None => {
                log_line("[dsh-desktop] plugin sync skipped: no dsh CLI found outside DSH_CMD");
            }
        }
    }
}

/// Spawn the launch-time update check on its own thread. Never blocks and
/// never fails loudly — errors reach the pill as a `failed` state.
pub fn spawn_check(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(message) = run_check(&app, false) {
            eprintln!("[dsh-desktop] self-update failed: {message}");
            let _ = app.emit("app-update", json!({ "state": "failed", "message": message }));
        }
    });
}

/// Tray-triggered on-demand check. Same flow as launch, but outcomes are
/// narrated with toasts; guarded so repeated menu clicks run one check.
pub fn check_now(app: AppHandle) {
    if CHECK_IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let result = run_check(&app, true);
        CHECK_IN_FLIGHT.store(false, Ordering::SeqCst);
        if let Err(message) = result {
            eprintln!("[dsh-desktop] on-demand update check failed: {message}");
            let _ = app.emit("app-update", json!({ "state": "failed", "message": message }));
            toast(&format!("检查前端更新失败:{message}"));
        }
    });
}
