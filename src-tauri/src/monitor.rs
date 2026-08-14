//! Listens to the DSH host event stream and fires a Windows notification when a
//! session finishes (running true→false) while the main window is hidden.
//!
//! The authoritative `running` state lives on the `events.host` WebSocket, not
//! in `session.list`; we build a per-session baseline from the first status
//! frames and only fire on the true→false edge (so steady idle never re-fires).

use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tauri_winrt_notification::{Duration as ToastDuration, Toast};
use tungstenite::client::IntoClientRequest;
use tungstenite::{connect, Message};
use uuid::Uuid;

const EVENTS_URL: &str = "ws://127.0.0.1:3080/api/events.host";
const HOST_ORIGIN: &str = "http://127.0.0.1:3080";
const DSH_BASE: &str = "http://127.0.0.1:3080";

/// Run the monitor until the app exits. Reconnects with capped backoff; the WS
/// connection succeeding doubles as the shared "DSH is alive" signal — no second
/// health-check is needed alongside the lifecycle probe.
pub fn run(app: AppHandle) {
    let baseline: Mutex<HashMap<String, Option<bool>>> = Mutex::new(HashMap::new());
    let mut attempt: u32 = 0;
    loop {
        attempt = attempt.saturating_add(1);
        match connect_and_listen(&app, &baseline) {
            Ok(()) => {
                // Orderly close — reset and reconnect fresh.
                attempt = 0;
                baseline.lock().unwrap().clear();
            }
            Err(_) => {
                // DSH gone (or not up yet) — drop the baseline so the next first
                // wave rebuilds it without mis-firing an edge.
                baseline.lock().unwrap().clear();
            }
        }
        // Backoff: 0.5s, 1s, 2s, 4s, 8s, capped at 10s.
        let exp = (attempt - 1).min(4);
        let delay_ms = (500u64 * 2u64.pow(exp)).min(10_000);
        thread::sleep(Duration::from_millis(delay_ms));
    }
}

/// Connect events.host and read until the socket closes/errors.
fn connect_and_listen(
    app: &AppHandle,
    baseline: &Mutex<HashMap<String, Option<bool>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Build the handshake from the URL via tungstenite's own request type
    // (avoids any http-crate version mismatch), then add Origin to satisfy the
    // /api trust fence. Host is already `127.0.0.1:3080` from the URL; a
    // non-browser client carries no sec-fetch-site, so Host+Origin suffices.
    let mut request = EVENTS_URL.into_client_request()?;
    request.headers_mut().insert(
        http::header::ORIGIN,
        http::HeaderValue::from_str(HOST_ORIGIN)?,
    );

    let (mut socket, _response) = connect(request)?;
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => handle_frame(app, baseline, &text),
            Ok(Message::Binary(bytes)) => {
                if let Ok(s) = std::str::from_utf8(&bytes) {
                    handle_frame(app, baseline, s);
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    Ok(())
}

/// Dispatch one `{type:"server-request", rpcId, payload}` frame by payload.type.
fn handle_frame(app: &AppHandle, baseline: &Mutex<HashMap<String, Option<bool>>>, text: &str) {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if value.get("type").and_then(|t| t.as_str()) != Some("server-request") {
        return;
    }
    let Some(payload) = value.get("payload") else {
        return;
    };
    let Some(frame_type) = payload.get("type").and_then(|t| t.as_str()) else {
        return;
    };

    match frame_type {
        "host/session-status" => {
            let Some(session_id) = payload.get("sessionId").and_then(|v| v.as_str()) else {
                return;
            };
            let Some(running) = payload.get("running").and_then(|v| v.as_bool()) else {
                return;
            };
            let prev = {
                let mut map = baseline.lock().unwrap();
                let prev = map.get(session_id).copied().flatten();
                map.insert(session_id.to_string(), Some(running));
                prev
            };
            // Edge only: must have a known baseline (Some) and cross true→false,
            // so the first wave of idle frames never fires.
            if prev == Some(true) && !running {
                on_task_finished(app, session_id);
            }
        }
        "host/session-added" => {
            if let Some(id) = payload.get("sessionId").and_then(|v| v.as_str()) {
                baseline.lock().unwrap().insert(id.to_string(), Some(false));
            }
        }
        "host/session-removed" => {
            if let Some(id) = payload.get("sessionId").and_then(|v| v.as_str()) {
                baseline.lock().unwrap().remove(id);
            }
        }
        _ => {}
    }
}

/// A session finished. Notify only if the user isn't already looking at it.
fn on_task_finished(app: &AppHandle, session_id: &str) {
    let visible = app
        .get_webview_window("main")
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    if visible {
        return;
    }

    let title = resolve_session_title(session_id).unwrap_or_else(|| "一个会话".to_string());
    let body = format!("任务已完成:{title}");

    let app2 = app.clone();
    // Short duration: the banner auto-collapses into Action Center if not tapped.
    // "明白" collapses the banner (any action click dismisses it); "打开窗口"
    // restores + focuses the window via the in-process activation callback.
    let _ = Toast::new(crate::TOAST_AUMID)
        .title("DSH")
        .text1(&body)
        .duration(ToastDuration::Short)
        .add_button("打开窗口", "open")
        .add_button("明白", "ack")
        .on_activated(move |action| {
            if action.as_deref() == Some("open") {
                crate::show_main_window(&app2);
            }
            Ok(())
        })
        .show();
}

/// Look up a session's display title for the notification body via session.list.
/// Falls back to None when DSH is unreachable or the session is gone.
fn resolve_session_title(session_id: &str) -> Option<String> {
    let body = json!({
        "type": "client-request",
        "rpcId": Uuid::new_v4().to_string(),
        "method": "session.list",
        "payload": {}
    });
    let response = ureq::post(&format!("{DSH_BASE}/api/session.list"))
        .set("Origin", HOST_ORIGIN)
        .timeout(Duration::from_secs(3))
        .send_json(body)
        .ok()?;
    let value: Value = response.into_json().ok()?;
    let items = value
        .get("result")?
        .get("value")?
        .get("items")?
        .as_array()?;
    for item in items {
        if item.get("sessionId").and_then(|v| v.as_str()) == Some(session_id) {
            return item
                .get("projections")?
                .get("values")?
                .get("title")?
                .as_str()
                .map(|s| s.to_string());
        }
    }
    None
}
