//! In-page context menu for hyperlinks on the 3080 webchat page.
//!
//! The WebView2 default menu is a generic Edge menu: items like "在新窗口中
//! 打开链接" actually shell out to the system browser (wry's NewWindowRequested
//! fallback) and several entries are dead weight. After the shell navigates to
//! the native webchat, poll-inject a small script that replaces the menu on
//! `<a href>` right-clicks with two honest items: open in the system browser
//! (reusing the same new-window fallback) and copy the link. Non-link
//! right-clicks keep the default menu.

use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Poll-inject the menu script until it lands on the 3080 page.
///
/// The boot page runs on tauri.localhost first; the script self-guards on
/// `location.origin` plus an install flag, so extra attempts are no-ops. The
/// webchat is an SPA — one successful install survives for the session.
pub fn install(app: AppHandle) {
    std::thread::spawn(move || {
        for _ in 0..45 {
            if let Some(webview) = app.get_webview_window("main") {
                let _ = webview.eval(MENU_SCRIPT);
            }
            std::thread::sleep(Duration::from_secs(2));
        }
    });
}

/// Idempotent installer + minimal custom menu, vanilla JS, dark styling to
/// match the webchat.
const MENU_SCRIPT: &str = r#"
(function () {
  if (window.__dshLinkMenu) return;
  if (location.origin !== 'http://127.0.0.1:3080') return;
  if (document.readyState === 'loading') return; // retried by the next poll
  window.__dshLinkMenu = true;

  var menu = null;
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }
  function openInBrowser(url) {
    // New-window request; the shell's fallback opens it in the system browser.
    window.open(url, '_blank', 'noopener');
  }
  function copyLink(url) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url);
    }
  }
  function showMenu(x, y, url) {
    closeMenu();
    menu = document.createElement('div');
    menu.setAttribute('style',
      'position:fixed;z-index:2147483647;min-width:180px;padding:4px 0;' +
      'background:#1c1f26;border:1px solid #3a4050;border-radius:8px;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.45);font:13px/1 system-ui,sans-serif;color:#e6e6e6;'
    );
    [['在浏览器中打开', function () { openInBrowser(url); }],
     ['复制链接', function () { copyLink(url); }]].forEach(function (item) {
      var row = document.createElement('div');
      row.textContent = item[0];
      row.setAttribute('style',
        'padding:7px 14px;cursor:pointer;white-space:nowrap;'
      );
      row.addEventListener('mouseenter', function () { row.style.background = '#2a3040'; });
      row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; });
      row.addEventListener('click', function (e) { e.stopPropagation(); closeMenu(); item[1](); });
      menu.appendChild(row);
    });
    document.documentElement.appendChild(menu);
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, innerWidth - w - 8) + 'px';
    menu.style.top = Math.min(y, innerHeight - h - 8) + 'px';
  }

  document.addEventListener('contextmenu', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, a.href);
  }, true);
  document.addEventListener('mousedown', function (e) {
    if (menu && !menu.contains(e.target)) closeMenu();
  }, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
})();
"#;
