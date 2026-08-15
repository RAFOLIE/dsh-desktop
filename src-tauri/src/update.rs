//! App self-update: on launch, compare the running version with the latest
//! GitHub Release, swap the exe aside when one exists, and narrate progress
//! to the boot page's version pill via `app-update` events.
//!
//! Runs on its own thread parallel to the DSH lifecycle; every failure is
//! silent (logged only) so a flaky network never blocks startup.

use serde_json::json;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const REPO_SLUG: &str = "RAFOLIE/dsh-desktop-windowos";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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

/// Download a release asset with system curl. Multi-MB binaries stall in some
/// HTTP clients on this network where curl succeeds — the plugin's installer
/// uses the exact same recipe.
fn download_with_curl(url: &str, dest: &Path) -> std::io::Result<()> {
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

/// The whole launch-time flow; each step narrates to the boot page.
fn run_check(app: &AppHandle) -> Result<(), String> {
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
        return Ok(());
    }

    narrate(json!({ "state": "downloading", "from": current, "to": to_version }));
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
    Ok(())
}

/// Spawn the launch-time update check on its own thread. Never blocks and
/// never fails loudly — errors reach the pill as a `failed` state.
pub fn spawn_check(app: AppHandle) {
    std::thread::spawn(move || {
        if let Err(message) = run_check(&app) {
            eprintln!("[dsh-desktop] self-update failed: {message}");
            let _ = app.emit("app-update", json!({ "state": "failed", "message": message }));
        }
    });
}
