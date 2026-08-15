//! App wiring: tray icon + menu, window close→hide, DSH lifecycle, and the
//! task-completion event monitor.

mod dsh;
mod menu;
mod monitor;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent,
};

/// AppUserModelID stamped on toasts; must match the registry registration in
/// `ensure_toast_aumid` and the tauri.conf identifier.
pub(crate) const TOAST_AUMID: &str = "com.dsh.desktop";

/// Frontend-invoked retry after a failed start.
#[tauri::command]
fn dsh_retry(app: AppHandle) {
    dsh::retry(app);
}

/// Frontend-invoked npx download consent after `notfound` (or as an error
/// fallback): persists the choice and runs the npx candidate.
#[tauri::command]
fn dsh_download(app: AppHandle) {
    dsh::download_and_start(app);
}

/// Frontend-invoked one-click global install: npm i -g @deepseek-ai/dsh,
/// then startup leads with the freshly installed global dsh.
#[tauri::command]
fn dsh_install_npm(app: AppHandle) {
    dsh::install_global_npm(app);
}

/// Frontend-invoked custom dsh path from the notfound dialog: validates it
/// exists, persists it, and retries startup with it leading the chain.
#[tauri::command]
fn dsh_custom_path(app: AppHandle, path: String) -> Result<(), String> {
    dsh::set_custom_path(&app, path)
}

/// Frontend-invoked exit from the notfound choice.
#[tauri::command]
fn dsh_exit(app: AppHandle) {
    dsh::teardown(&app);
    app.exit(0);
}

/// Show and focus the main window (tray double-click / Open DSH menu item /
/// toast "打开窗口" button / second-instance relaunch).
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Quit path: tear down our DSH subprocess tree, then exit. Attached mode tears
/// down to nothing and leaves the pre-existing instance running.
fn quit_dsh(app: &AppHandle) {
    dsh::teardown(app);
    app.exit(0);
}

/// Windows toast identity for a portable bare exe. tauri-plugin-notification
/// stamps toasts with the app identifier as AppUserModelID, but Windows only
/// displays toasts for an AUMID registered via an installer's Start Menu
/// shortcut — and we deliberately ship without an installer. Register the AUMID
/// through the documented registry alternative instead (the same method other
/// portable apps use); without it Windows silently drops every toast.
/// Idempotent; a failure only degrades toast attribution, never the app.
#[cfg(windows)]
fn ensure_toast_aumid() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    // Must equal the tauri.conf.json identifier the notification stamps.
    const AUMID: &str = TOAST_AUMID;
    let register = |exe: &std::path::Path| -> std::io::Result<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey(format!(
            r"Software\Classes\AppUserModelId\{AUMID}"
        ))?;
        key.set_value("DisplayName", &"DeepSeek Harness")?;
        // Strip the `\\?\` verbatim prefix current_exe() can carry — Windows
        // expects a plain path here for the toast attribution icon.
        let exe_path = exe.display().to_string();
        let exe_path = exe_path.strip_prefix(r"\\?\").unwrap_or(&exe_path);
        key.set_value("IconUri", &exe_path)?;
        Ok(())
    };
    match tauri::utils::platform::current_exe() {
        Ok(exe) => {
            if let Err(e) = register(&exe) {
                eprintln!("[dsh-desktop] toast AUMID registration failed: {e}");
            }
        }
        Err(e) => eprintln!("[dsh-desktop] toast AUMID registration skipped: {e}"),
    }
}

/// Keep the tray icon pinned to the taskbar. Windows 11 identifies tray icons
/// by exe path under `HKCU\Control Panel\NotifyIconSettings` and defaults new
/// identities to the hidden overflow; `IsPromoted = 1` is exactly the value
/// Windows writes when a user unhides an icon. Without this the placement
/// resets into the overflow on every launch. Retried briefly because the key
/// only appears shortly after the tray icon registers. A failure is cosmetic
/// and never blocks the app.
#[cfg(windows)]
fn ensure_tray_promoted() {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let Ok(exe) = tauri::utils::platform::current_exe() else { return };
    let exe = exe
        .display()
        .to_string()
        .strip_prefix(r"\\?\")
        .unwrap_or(&exe.display().to_string())
        .to_lowercase();
    let root = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"Control Panel\NotifyIconSettings", KEY_READ | KEY_WRITE);
    let Ok(root) = root else { return };
    for key in root.enum_keys().flatten() {
        let Ok(sub) = root.open_subkey_with_flags(&key, KEY_READ | KEY_WRITE) else { continue };
        let Ok(path) = sub.get_value::<String, _>("ExecutablePath") else { continue };
        if path.to_lowercase() != exe { continue }
        let _: std::io::Result<()> = sub.set_value("IsPromoted", &1u32);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {    tauri::Builder::default()
        // Registered first: a second launch (e.g. toast foreground activation,
        // or the user double-clicking the exe again) focuses the existing window
        // instead of starting a second instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .manage(dsh::DshState::new())
        .invoke_handler(tauri::generate_handler![dsh_retry, dsh_download, dsh_custom_path, dsh_install_npm, dsh_exit])
        .setup(|app| {
            #[cfg(windows)]
            ensure_toast_aumid();

            // The window is built here (not in tauri.conf.json) so it can carry
            // a new-window handler: every new-window request (target=_blank
            // links, window.open from the link menu) is handed to the system
            // default browser instead of being silently denied by wry.
            let opener_app = app.handle().clone();
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("DeepSeek Harness")
            .inner_size(1280.0, 800.0)
            .on_new_window(move |url, _features| {
                let app = opener_app.clone();
                let url = url.to_string();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app.opener().open_url(url, None::<&str>);
                });
                tauri::webview::NewWindowResponse::Deny
            })
            // Capture the boot page's real URL when it finishes loading.
            // Right after build the webview still sits on about:blank, so a
            // build-time url() is unusable — tray "重启 DSH" needs the real
            // URL to hand the window back to the boot page. First real page
            // wins (OnceLock); the later webchat load cannot overwrite it.
            .on_page_load(|_webview, payload| {
                use tauri::webview::PageLoadEvent;
                if payload.event() == PageLoadEvent::Finished {
                    let url = payload.url().to_string();
                    if !url.starts_with("about:") {
                        let _ = dsh::BOOT_URL.set(url);
                    }
                }
            })
            .build()?;

            let open = MenuItem::with_id(app, "open", "Open DSH", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启 DSH", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出(关闭 DSH)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &restart, &quit])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(
                    app.default_window_icon()
                        .expect("default window icon missing")
                        .clone(),
                )
                .tooltip("DeepSeek Harness")
                .menu(&menu)
                // Left-click should not pop the menu; double-click opens the window.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "restart" => dsh::restart(app.clone()),
                    "quit" => quit_dsh(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Tray icon pinning: Windows creates the per-icon settings key
            // only moments after the tray registers, so retry briefly on a
            // side thread — never block startup on it.
            std::thread::spawn(|| {
                for _ in 0..5 {
                    ensure_tray_promoted();
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            });

            // DSH lifecycle (probe/spawn/wait) and the event monitor run on their
            // own blocking threads; both share the AppHandle.
            let lifecycle = app.handle().clone();
            std::thread::spawn(move || dsh::startup(lifecycle));
            let monitor_app = app.handle().clone();
            std::thread::spawn(move || monitor::run(monitor_app));

            Ok(())
        })
        .on_window_event(|window, event| {
            // X hides to tray; DSH keeps running. Only tray "退出" actually exits.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
