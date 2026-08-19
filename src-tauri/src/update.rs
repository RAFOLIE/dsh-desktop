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

/// Public GitHub asset mirrors (prefix + full asset URL), the last-resort
/// tier for proxy-less networks where GitHub's CDN is blocked. Everything
/// fetched through them is verified against the API's own size/digest.
const ASSET_MIRRORS: &[&str] = &[
    "https://ghproxy.com/",
    "https://gh-proxy.com/",
    "https://ghfast.top/",
];

/// Local proxy ports worth probing, covering the common Clash/v2rayN
/// setups (7897 included: real-world case where 7890/7891 missed).
const LOCAL_PROXY_PORTS: &[&str] = &["7890", "7891", "7897", "7898", "10808", "10809"];

/// One download route: direct, through a proxy, or through a public mirror.
#[derive(Debug)]
enum Route {
    Direct,
    Proxy(String),
    Mirror(String),
}

fn env_proxies() -> Vec<String> {
    let mut list = Vec::new();
    for key in [
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() && !list.contains(&value) {
                list.push(value);
            }
        }
    }
    list
}

/// The ordered chain serving three user profiles: overseas (direct hits),
/// proxied (env override, then probed local ports), proxy-less China (public
/// mirrors). Dead paths fail fast (--connect-timeout 8).
fn download_routes() -> Vec<Route> {
    let mut routes = vec![Route::Direct];
    for proxy in env_proxies() {
        routes.push(Route::Proxy(proxy));
    }
    for port in LOCAL_PROXY_PORTS {
        let proxy = format!("http://127.0.0.1:{port}");
        if proxy_alive(&proxy) {
            routes.push(Route::Proxy(proxy));
        }
    }
    for mirror in ASSET_MIRRORS {
        routes.push(Route::Mirror(mirror.to_string()));
    }
    routes
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

/// One curl run for a route; proxies add `-x`, mirrors fetch `prefix + url`.
fn curl_route(url: &str, dest: &Path, route: &Route) -> std::io::Result<()> {
    let mut command = std::process::Command::new("curl");
    command.args([
        "--silent",
        "--show-error",
        "--location",
        "--fail",
        "--retry",
        "1",
        "--connect-timeout",
        "8",
        "--speed-time",
        "30",
        "--speed-limit",
        "1024",
        "--max-time",
        "120",
        "--user-agent",
        "dsh-desktop-windowos",
        "--output",
    ]);
    match route {
        Route::Direct => {
            command.arg(dest).arg(url);
        }
        Route::Proxy(proxy) => {
            command.arg(dest).arg(url).arg("-x").arg(proxy);
        }
        Route::Mirror(prefix) => {
            command.arg(dest).arg(format!("{prefix}{url}"));
        }
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
        Err(std::io::Error::other(format!("curl exit {status} via {route:?}")))
    }
}

/// Verify a downloaded asset against the GitHub API's own metadata: exact
/// byte size always, sha256 when the API provided a digest. This is what
/// makes public mirrors safe to use — a tampered or truncated mirror file
/// is discarded and the next route tried.
fn verify_download(dest: &Path, size: u64, digest: Option<&str>) -> bool {
    let Ok(bytes) = std::fs::read(dest) else {
        return false;
    };
    if bytes.len() as u64 != size {
        return false;
    }
    match digest.and_then(|d| d.strip_prefix("sha256:")) {
        Some(hex) => {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let got = format!("{:x}", hasher.finalize());
            got.eq_ignore_ascii_case(hex)
        }
        None => true, // no digest advertised: size match is the contract
    }
}

/// Download a release asset through the whole route chain, verifying each
/// successful transfer; the first route that both transfers and verifies
/// wins. A silently-failing single route is what kept exe updates stuck.
fn download_with_curl(url: &str, dest: &Path, size: u64, digest: Option<&str>) -> std::io::Result<()> {
    let routes = download_routes();
    let mut last_error = String::from("no route attempted");
    for route in routes {
        match curl_route(url, dest, &route) {
            Ok(()) => {
                if verify_download(dest, size, digest) {
                    log_line(&format!("[dsh-desktop] asset downloaded via {route:?} (verified)"));
                    return Ok(());
                }
                log_line(&format!(
                    "[dsh-desktop] asset via {route:?} failed integrity check; trying next route"
                ));
                let _ = std::fs::remove_file(dest);
                last_error = format!("integrity mismatch via {route:?}");
            }
            Err(e) => {
                log_warn(&format!("[dsh-desktop] {e}"));
                last_error = e.to_string();
            }
        }
    }
    Err(std::io::Error::other(format!(
        "all download routes failed for {url} ({last_error})"
    )))
}

/// Tray/panel「前后端重启」: arm the detached relaunch helper onto the
/// same exe, tear down the owned DSH tree, then exit. The fresh instance
/// re-runs the whole startup chain (shell + DSH backend) — the go-to when a
/// wedged plugin leaves even the webchat unusable. Only exits when the
/// helper is armed, so a failed arm never turns a restart into a quit.
pub fn restart_app(app: &AppHandle) {
    if let Ok(exe) = tauri::utils::platform::current_exe() {
        if relaunch_app(&exe) {
            // Stop the backend unconditionally (owned tree AND any attached
            // external listener on 3080) — a "complete restart" that leaves
            // an old backend behind keeps freshly installed plugins in
            // 「重启后生效」 limbo forever (2026-08-19 report).
            crate::dsh::stop_backend(app);
            app.exit(0);
        }
    }
}

/// Relaunch the app onto the freshly swapped exe. A detached helper waits for
/// this process to exit (releasing the single-instance lock), then starts the
/// new exe. The exit skips DSH teardown on purpose: a running webchat backend
/// stays up and the new instance attaches to it instead of respawning.
/// Returns whether the helper armed successfully.
fn relaunch_app(exe: &Path) -> bool {
    let mut command = std::process::Command::new("cmd");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // `ping -n 4` is the quote-proof, PATH-proof ~3s delay (cmd's
        // builtin `timeout` loses to a GNU timeout.exe on some PATHs);
        // `start "" "path"` is the safe launcher for spaced paths. After /S
        // strips the outer quotes the helper reads:
        //   ping -n 4 127.0.0.1 >nul & start "" "C:\...\app.exe"
        command.raw_arg(format!(
            "/S /C \"ping -n 4 127.0.0.1 >nul & start \"\" \"{}\"\"",
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
        Ok(_) => {
            log_line("[dsh-desktop] relaunch helper armed (starts the new exe in ~3s)");
            true
        }
        Err(e) => {
            log_line(&format!(
                "[dsh-desktop] relaunch helper failed ({e}); the new version activates on next manual launch"
            ));
            false
        }
    }
}

/// GET a JSON API directly first, then through every reachable proxy —
/// api.github.com is usually open even where the CDN is not, but a proxied
/// machine should not depend on that luck.
fn api_get_json(url: &str) -> Option<serde_json::Value> {
    let attempt = |proxy: Option<&str>| -> Option<serde_json::Value> {
        let mut builder = ureq::AgentBuilder::new().timeout(Duration::from_secs(6));
        if let Some(proxy) = proxy {
            builder = builder.proxy(ureq::Proxy::new(proxy).ok()?);
        }
        let response = builder
            .build()
            .get(url)
            .set("User-Agent", "dsh-desktop-windowos")
            .set("Accept", "application/vnd.github+json")
            .call()
            .ok()?;
        response.into_json().ok()
    };
    if let Some(value) = attempt(None) {
        return Some(value);
    }
    let mut proxies = env_proxies();
    for port in LOCAL_PROXY_PORTS {
        let proxy = format!("http://127.0.0.1:{port}");
        if proxy_alive(&proxy) && !proxies.contains(&proxy) {
            proxies.push(proxy);
        }
    }
    proxies.iter().find_map(|p| attempt(Some(p)))
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
    let api_url = format!("https://api.github.com/repos/{REPO_SLUG}/releases/latest");
    let body = api_get_json(&api_url)
        .ok_or_else(|| format!("github api unreachable directly and via proxies: {api_url}"))?;

    // (version, url, size, digest) — the metadata powers the integrity check
    // that makes mirror downloads trustworthy.
    let mut latest: Option<(String, String, u64, Option<String>)> = None;
    if let Some(assets) = body["assets"].as_array() {
        for asset in assets {
            let name = asset["name"].as_str().unwrap_or_default();
            let url = asset["browser_download_url"].as_str().unwrap_or_default();
            let size = asset["size"].as_u64().unwrap_or_default();
            let digest = asset["digest"].as_str().map(str::to_string);
            if let Some(version) = parse_asset_version(name) {
                latest = Some((version.to_string(), url.to_string(), size, digest));
                break;
            }
        }
    }
    let Some((to_version, url, asset_size, asset_digest)) = latest else {
        narrate(json!({ "state": "failed", "message": "latest release has no versioned exe asset" }));
        return Ok(());
    };
    if compare_versions(&to_version, &current) <= 0 {
        narrate(json!({ "state": "none" }));
        if on_demand {
            toast(&format!("前端已是最新版本 v{current}"));
        }
        sync_plugin_packages();
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
    download_with_curl(&url, &tmp, asset_size, asset_digest.as_deref())
        .map_err(|e| format!("download: {e}"))?;

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
    // The running process still has the old code (e.g. the window's drag-drop
    // settings were fixed at build time), so restart onto the new exe. The
    // plugin-package sync deliberately does NOT run here — a slow or hung
    // pnpm must never sit between the swap and the restart. The new
    // process's own launch check (state `none`) performs the sync instead.
    if on_demand {
        toast(&format!("已更新到 v{to_version},正在重启…"));
    }
    log_line(&format!(
        "[dsh-desktop] exe updated {current} -> {to_version}; restarting onto the new build"
    ));
    std::thread::sleep(Duration::from_secs(2));
    relaunch_app(&exe);
    app.exit(0);
    Ok(())
}

/// Append one line to the shared shell log beside the exe updater's output.
/// Routes through dsh's timestamped writer so the log tab colors uniformly;
/// the `[dsh-desktop] ` prefix stays as the source tag.
fn log_line(line: &str) {
    crate::dsh::log_write(crate::dsh::LogLevel::Info, line);
}

/// Same, at Warn (recoverable failures, fallbacks engaged).
fn log_warn(line: &str) {
    crate::dsh::log_write(crate::dsh::LogLevel::Warn, line);
}

/// Same, at Error (the operation failed outright).
fn log_error(line: &str) {
    crate::dsh::log_write(crate::dsh::LogLevel::Error, line);
}

/// Run one shell command hidden, with CI=true (pnpm blocks forever on an
/// interactive prompt without a TTY). Bounded by a hard kill at 120s — a
/// hung pnpm must never stall anything downstream (it once sat between the
/// exe swap and the restart).
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
    let Ok(mut child) = command.spawn() else {
        log_line(&format!("[dsh-desktop] plugin sync spawn failed: {cmd}"));
        return false;
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let ok = status.success();
                log_line(&format!(
                    "[dsh-desktop] plugin sync {} (exit {})",
                    if ok { "ok" } else { "FAILED" },
                    status.code().unwrap_or(-1),
                ));
                return ok;
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    log_warn("[dsh-desktop] plugin sync timed out after 120s (killed); retried next launch");
                    return false;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            Err(e) => {
                log_warn(&format!("[dsh-desktop] plugin sync wait failed: {e}"));
                return false;
            }
        }
    }
}

/// The plugin's npm latest version. The app and the plugin share a version
/// line only historically — npm publishes are on-demand now, so the sync
/// target is whatever npm actually has, never the app's own version (which
/// usually runs ahead).
fn npm_latest_plugin_version() -> Option<String> {
    let response = ureq::get(&format!("https://registry.npmjs.org/{PLUGIN_NAME}"))
        .set("Accept", "application/vnd.npm.install-v1+json")
        .timeout(Duration::from_secs(8))
        .call()
        .ok()?;
    let doc: serde_json::Value = response.into_json().ok()?;
    doc["dist-tags"]["latest"].as_str().map(str::to_string)
}

/// The dsh-desktop-plugin version actually installed in a profile (reads
/// node_modules, the ground truth pnpm leaves behind).
fn profile_plugin_version(profile_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(
        profile_dir.join("node_modules").join(PLUGIN_NAME).join("package.json"),
    )
    .ok()?;
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()?
        ["version"]
        .as_str()
        .map(str::to_string)
}

/// Keep the npm-installed plugin package on npm's latest: for every DSH
/// profile that ALREADY has `{PLUGIN_NAME}` installed, pin it to the npm
/// latest via `dsh plugin add` with the one-shot pnpm fresh-release bypass —
/// the same override dshmarket's "update now" uses. Profiles without the
/// plugin are never touched (no silent installs), and steady state (versions
/// equal) spawns nothing at all.
///
/// Exit code alone is NOT success: pnpm's fresh-release cooldown silently
/// keeps the old version and still exits 0 (2026-08-18 home report — "sync
/// ok" while node_modules never received the target). Every install is
/// therefore verified by re-reading node_modules, with one retry and an
/// explicit cooldown pointer on failure.
fn sync_plugin_packages() {
    let Some(target) = npm_latest_plugin_version() else {
        log_line("[dsh-desktop] plugin sync skipped: npm latest unavailable");
        return;
    };
    let home = std::env::var("DSH_HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    let profiles_root = Path::new(&home).join(".dsh").join("profiles");
    let Ok(dirs) = std::fs::read_dir(&profiles_root) else {
        return;
    };
    for entry in dirs.flatten() {
        let profile = entry.file_name().to_string_lossy().to_string();
        // Profiles without a readable plugin install are never touched —
        // this also skips pnpm's workspace-level `profiles/node_modules`,
        // which is not a profile at all.
        let Some(installed) = profile_plugin_version(&entry.path()) else {
            continue;
        };
        if installed == target || compare_versions(&installed, &target) >= 0 {
            continue;
        }
        log_line(&format!(
            "[dsh-desktop] syncing {PLUGIN_NAME} {installed} -> {target} in profile {profile}"
        ));
        let sub = format!("plugin --profile {profile} add {PLUGIN_NAME}@{target} --config.minimumReleaseAge=0");
        match dsh::dsh_cli_command(&sub) {
            Some(cmd) => {
                run_logged(&cmd);
                match profile_plugin_version(&entry.path()) {
                    Some(v) if v == target => {
                        log_line(&format!(
                            "[dsh-desktop] plugin sync verified: {PLUGIN_NAME}@{v} in profile {profile}"
                        ));
                    }
                    found => {
                        log_warn(&format!(
                            "[dsh-desktop] plugin sync NOT verified in profile {profile} (found {found:?}, want {target}) — pnpm 新发布冷却期会静默保留旧版且退出码为 0;重试一次"
                        ));
                        if let Some(cmd) = dsh::dsh_cli_command(&sub) {
                            run_logged(&cmd);
                        }
                        match profile_plugin_version(&entry.path()) {
                            Some(v) if v == target => {
                                log_line(&format!(
                                    "[dsh-desktop] plugin sync verified after retry: {PLUGIN_NAME}@{v} in profile {profile}"
                                ));
                            }
                            still => {
                                log_warn(&format!(
                                    "[dsh-desktop] plugin sync仍未验证 (found {still:?});手动处理:执行 dsh plugin --profile {profile} add {PLUGIN_NAME}@{target},或等冷却期(约 24h)后下次启动自动同步"
                                ));
                            }
                        }
                    }
                }
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
            log_error(&format!("[dsh-desktop] self-update failed: {message}"));
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
            log_line(&format!("[dsh-desktop] on-demand update check failed: {message}"));
            let _ = app.emit("app-update", json!({ "state": "failed", "message": message }));
            toast(&format!("检查前端更新失败:{message}"));
        }
    });
}
