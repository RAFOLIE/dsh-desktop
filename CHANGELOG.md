# Changelog

## v1.2.1 — 2026-08-14

修复:链接的「在浏览器中打开」与左键点击外链未打开系统浏览器。

- 根因:WebView2 新窗口请求在未注册处理器时被 wry 静默拒绝
- 主窗口改为 Rust 侧创建并注册 `on_new_window` 处理器:所有新窗口请求(target=_blank 链接、菜单的 window.open)经 opener 插件交给系统默认浏览器打开
- 行为现在确定一致:菜单「在浏览器中打开」、左键点外链均打开系统默认浏览器

Fix: "Open in browser" on links and left-click on external links did nothing.

- Root cause: WebView2 new-window requests are silently denied by wry when no handler is registered
- The main window is now created in Rust with an `on_new_window` handler: every new-window request (target=_blank links, the menu's window.open) is handed to the system default browser via the opener plugin
- Behavior is now deterministic: both the menu item and left-click open the system default browser

## v1.2.0 — 2026-08-14

链接右键菜单重做。

- 在 webchat 页面右键链接:自绘菜单替换 WebView2 默认 Edge 菜单,仅两项——「在浏览器中打开」「复制链接」
- 默认菜单的问题:「在新窗口中打开链接」实际跳系统默认浏览器且文案误导,「发送标签页到你的设备」等项无用
- 左键点击外链行为不变(仍由系统默认浏览器打开);非链接区域的右键菜单不变
- 实现:就绪后 Rust 侧轮询注入幂等 JS(document 级捕获 contextmenu,匹配 `a[href]`)

Reworked right-click menu for links.

- Right-clicking a link in the webchat now shows a custom two-item menu — "Open in browser" / "Copy link" — replacing the default WebView2 Edge menu
- The default menu was misleading ("open in new window" actually shelled out to the system browser) and carried dead entries
- Left-click on external links keeps opening the system default browser; non-link right-clicks keep the default menu
- Implementation: idempotent JS poll-injected from Rust after readiness (document-level contextmenu capture matching `a[href]`)

## v1.1.1 — 2026-08-14

项目更名:`dsh-desktop` → `dsh-desktop-windowos`(与同名第三方项目区分)。

- 本地目录、npm 包名、Cargo 包名、产物 exe(`dsh-desktop-windowos.exe`)、GitHub 仓库全部同步更名
- 运行时行为不变:窗口标题、AUMID/通知标识、数据目录(`%LOCALAPPDATA%\dsh-desktop\`)均保持

Project renamed: `dsh-desktop` → `dsh-desktop-windowos` (disambiguation from a same-name third-party project).

- Local folder, npm package name, Cargo package name, built exe (`dsh-desktop-windowos.exe`), and the GitHub repo all renamed together
- Runtime behavior unchanged: window title, AUMID/toast identity, and data dir (`%LOCALAPPDATA%\dsh-desktop\`) kept as-is

## v1.1.0 — 2026-08-14

启动方式与文件路径解耦,改用官方命令行。

- 启动候选链:`DSH_CMD` 环境变量 → `dsh web`(全局安装)→ `npx @deepseek-ai/dsh web`(官方零安装命令,仅需 Node)
- 每个候选独立就绪窗口,失败自动降级;所有尝试写入 dsh.log 并聚合进错误信息
- 移除编译期写死的仓库路径;boot 页显示当前启动方式
- 其它用户装好 DSH(或仅有 Node)即可直接使用,不再因本机路径报错

Launch decoupled from file paths; now uses the official CLI.

- Candidate chain: `DSH_CMD` env var → `dsh web` (global install) → `npx @deepseek-ai/dsh web` (official zero-install, Node.js only)
- Per-candidate readiness windows with automatic fallback; every attempt logged to dsh.log and aggregated into the error report
- Compiled-in repo path removed; boot page shows the active launch method
- Other users just need DSH installed (or Node alone) — no more machine-specific path failures

## v1.0.0 — 2026-08-14

首版发布。Initial release.

- 冷启动自动拉起 DSH,窗口直连 3080 原生 webchat
- 托盘常驻:X 隐藏到托盘(DSH 继续运行),双击托盘 / 右键 Open DSH 唤回
- 任务完成系统通知:「打开窗口」/「明白」两按钮,超时自动收起
- 附加模式:已有 DSH 在跑则直接连接,退出不动别人实例
- 托盘退出 `taskkill /T` 整树清理,零孤儿进程
- 单实例保护;AUMID 注册表注册保证裸 exe 通知可达
- DeepSeek 鲸鱼品牌蓝图标;单个免安装裸 exe(约 4.5 MB)

- Auto-start DSH on launch; window shows the native webchat at 3080
- Tray-resident: X hides to tray (DSH keeps running); tray double-click / Open DSH restores
- Task-done toast with "Open Window" / "Got it" buttons, auto-collapse on timeout
- Attach mode: connect to an already-running DSH; never kill an instance we didn't start
- Tray quit tears down the spawned tree via `taskkill /T`, zero orphans
- Single-instance guard; AUMID registry registration keeps toasts working without an installer
- DeepSeek whale brand-blue icon; single portable bare exe (~4.5 MB)
