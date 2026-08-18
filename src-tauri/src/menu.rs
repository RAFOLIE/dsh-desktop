//! In-page context menu for hyperlinks on the 3080 webchat page.
//!
//! The WebView2 default menu is a generic Edge menu: items like "在新窗口中
//! 打开链接" actually shell out to the system browser (wry's NewWindowRequested
//! fallback) and several entries are dead weight. The webchat loads inside the
//! shell's iframe now, so the script rides along as a webview initialization
//! script — WebView2 runs those in every frame, and the script self-guards on
//! `location.origin`, so it installs exactly once per webchat document and
//! no-ops on the shell's own page. It replaces the menu on `<a href>`
//! right-clicks with two honest items: open in the system browser (reusing the
//! same new-window fallback) and copy the link. Non-link right-clicks keep the
//! default menu.

/// Registered at window build time (`initialization_script`); see module docs.
pub(crate) const MENU_SCRIPT: &str = r#"
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
