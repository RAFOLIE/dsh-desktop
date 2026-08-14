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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Registered first: a second launch (e.g. toast foreground activation,
        // or the user double-clicking the exe again) focuses the existing window
        // instead of starting a second instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(dsh::DshState::new())
        .invoke_handler(tauri::generate_handler![dsh_retry])
        .setup(|app| {
            #[cfg(windows)]
            ensure_toast_aumid();

            let open = MenuItem::with_id(app, "open", "Open DSH", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出(关闭 DSH)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;

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
                    "quit" => quit_dsh(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::DoubleClick { .. } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

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
