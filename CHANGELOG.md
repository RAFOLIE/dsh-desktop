# Changelog

## v1.4.1 — 2026-08-14

修复:本地安装候选在**路径含空格**时启动失败。

- 根因:命令串先经 std 自动参数转义(整体再包一层引号、内部引号加反斜杠),再交 `cmd /C` 解析,多层引号规则互相冲突,带空格的 `node_modules\.bin\dsh.cmd` 路径被切碎
- 修法:改用 `raw_arg` 走标准 `cmd /S /C "整条命令"` 形式——`/S` 只剥最外层引号,内部引号原样保留;所有候选(DSH_CMD/dsh web/本地安装/npx)统一受益
- 已实测:在 `…\dsh space test` 目录放置本地安装,启动一次命中、10 秒就绪

Fix: the project-local install candidate failed when its **path contained spaces**.

- Root cause: the command string went through std's automatic argument quoting (re-wrapped whole-string quotes, backslash-escaped inner quotes) and then cmd's own parsing — the layers conflict and the space-containing `node_modules\.bin\dsh.cmd` path got mangled
- Fix: spawn via `raw_arg` using the canonical `cmd /S /C "whole command"` form — `/S` strips only the outermost quote pair, inner quotes pass through verbatim; all candidates (DSH_CMD / dsh web / local install / npx) benefit
- Verified: a local install placed in `…\dsh space test` starts on the first hit, ready in ~10s

## v1.4.0 — 2026-08-14

启动链改为「本地优先、下载需确认」,并支持项目本地安装的 DSH。

- 新增本地搜索:除 PATH 全局安装外,还按序搜索 exe 同目录、工作目录、用户目录下的 `node_modules\.bin\dsh.cmd`(覆盖 `pnpm add @deepseek-ai/dsh` 装在 exe 旁边/项目里的用法),命中后直接用它启动
- 全部本地候选都不存在时不再静默走 npx 下载,启动页弹出选择:「下载并启动(首次约几分钟)」「重新检测」「退出」,并提示 `npm i -g @deepseek-ai/dsh` 一劳永逸
- 选过「下载并启动」后记住选择(写在 `%LOCALAPPDATA%\dsh-desktop\settings.json`),下次冷启动自动把 npx 候选接到链尾,不再询问;本地候选命中时仍优先本地
- 启动失败页新增「改用 npx 下载启动」兜底按钮

Startup chain reworked: local-first, download only with consent — plus project-local DSH support.

- Local search: besides a PATH-global install, `node_modules\.bin\dsh.cmd` is searched in the exe's directory, the working directory, then the user profile (covers `pnpm add @deepseek-ai/dsh` next to the exe or in a project); a hit is used directly
- When no local candidate exists, the app no longer silently starts the npx download: the boot page offers "下载并启动 (download, ~minutes on first run)", "重新检测 (re-detect)" and "退出 (exit)", plus a hint that `npm i -g @deepseek-ai/dsh` removes the question permanently
- The download choice persists (`%LOCALAPPDATA%\dsh-desktop\settings.json`): later cold starts append the npx candidate automatically without asking; local candidates still win when present
- The error page gains a "改用 npx 下载启动" fallback button

## v1.3.0 — 2026-08-14

托盘新增「重启 DSH」,无需退出应用再点桌面快捷方式。

- 托盘右键菜单新增「重启 DSH」:窗口回到启动页 → 杀掉 3080 上的 DSH 进程树(自己拉起的或附加的均处理)→ 等旧实例退出 → 重走启动候选链;会话数据在 `~/.dsh` 持久化,重启不丢失
- 附加模式下通过 netstat 定位 3080 监听进程再整树查杀
- 顺带修复:`DSH_CWD` 环境变量指向已删除目录时,候选全部失败并报「目录名称无效 (os error 267)」——现在回退到用户主目录,陈旧变量不再导致启动瘫痪
- npx 首次安装的等待上限从 120 秒提高到 300 秒(实际首装 500+ 依赖可超过两分钟);启动页在走 npx 候选时提示「首次运行需下载 DSH 包,可能需要几分钟」
- README 的 Node.js 版本要求从 ≥20 修正为 ^22.19 或 ≥ 24,与 DSH 源码声明一致

Tray gains "重启 DSH" (Restart DSH) — no more quitting and re-launching from the desktop shortcut.

- New tray menu item: the window returns to the boot page, the DSH process tree on 3080 is killed (spawned or attached alike), startup waits for the old instance to die, then re-runs the candidate chain; sessions live in `~/.dsh` and survive the restart
- In attached mode the listener PID on 3080 is located via netstat and tree-killed
- Also fixes: a stale `DSH_CWD` pointing at a deleted directory used to fail every candidate with "directory name invalid" (os error 267) — it now falls back to the user profile dir
- The npx first-install readiness window is raised from 120s to 300s (a real first install of 500+ dependencies took over two minutes); the boot page now hints "first run downloads the DSH package and may take a few minutes" while the npx candidate is running
- README's Node.js requirement corrected from ≥20 to ^22.19 or ≥ 24, matching what the DSH source declares

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
