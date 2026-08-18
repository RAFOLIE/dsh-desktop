# DSH Desktop (dsh-desktop-windowos)

**[中文](#中文) | [En](#english)**

<p align="center">
  <img src="docs/screenshot-v2.png" alt="DSH Desktop — native webchat in the shell window" width="860">
</p>

---

## 中文

DeepSeek Harness(DSH)的 Windows 桌面壳,基于 **Tauri v2 + React 18 + TypeScript**。
打开应用 → 自动拉起本机 DSH Web 服务 → 窗口内嵌原生 webchat(常驻壳) → 托盘常驻,任务完成弹系统通知。
交付物是**单个免安装裸 exe**(约 4.5 MB)。

**推荐用法**:在任意文件夹执行 `pnpm add @deepseek-ai/dsh`(或 `npm i @deepseek-ai/dsh`),把 exe 放进**同一文件夹的根目录**双击即可——应用自动发现旁边的 `node_modules\.bin\dsh.cmd`,启动零下载、零配置、不询问。

### 功能

- **开箱即用**:双击 exe 自动启动 DSH(`dsh web`),就绪后窗口内嵌 `http://127.0.0.1:3080/` 的**原生 webchat 界面**(iframe 常驻壳,不自创聊天 UI、不做反向代理)
- **自绘标题栏**:无边框窗口,鲸鱼标 + 「DeepSeek Harness」居中——**点名字打开环境管理面板**;拖拽区/最小化/最大化/关闭自绘,Win 贴靠与边缘缩放原生保留
- **环境管理面板**:搜索栏(过滤字段名与值)+ 环境|日志 标签 + 四组信息卡(运行状态/DSH 内核/组件版本/位置与存储;主功能标题在卡片外,子功能共处一个大圆角卡)+ 底部 刷新检测/重启/更多;复制⧉、打开目录📁一键图标,聊天状态在面板期间保留(背后虚化)
- **日志体系(ComfyUI 式)**:dsh.log 只记壳自身事件(启动/监护/更新;DSH web 输出不入日志,不再膨胀),`[本地时间] [INFO/WARN/ERROR]` 格式逐行着色,每次启动轮转历史文件;启动页「查看日志」实时看终端在跑什么;日志页带等级筛选/自动跟随/清空显示
- **诊断包**:面板「更多 → 导出诊断信息」一键把环境配置+本次日志组装成 markdown——复制到剪贴板可直接粘贴给 AI 排障,无需翻目录查全局安装
- **托盘常驻**:关闭窗口(X)只是隐藏到托盘,DSH 后台继续运行;**双击托盘图标**或**右键 → Open DSH** 随时唤回窗口;右键还有「重启 dsh web(后端)」「重启前端(完整重启)」「检查前端更新」「环境信息」
- **DSH 监护自愈**:DSH 意外退出(市场更新自重启/崩溃)时自动重拉并刷新界面,无需人工干预;连续快速崩溃自动熔断报错
- **自动更新带进度**:更新时顶栏名字旁绿色圆环旋转 → 完成对勾 → **自动重启生效**(无需手动重开;更新只在启动时发生,不打断对话);应用每次启动自检 GitHub 最新 Release
- **插件包自动同步(带验真)**:应用启动时自动把已安装的 dsh-desktop-plugin 对齐到 **npm 最新版**(只升不降,带 pnpm 新发布冷却期旁路);安装后回读 node_modules 验证真实落地,pnpm 冷却期静默保留旧版不再虚报成功
- **图片拖放/粘贴**:与浏览器一致——可拖入或粘贴 png/jpg/webp/gif 作为对话附件(DSH v1 支持的四种格式)
- **一键重启 DSH**:托盘「重启 dsh web(后端)」只重启 DSH 服务(会话数据在 `~/.dsh` 持久化);「重启前端(完整重启)」连壳带后端全新拉起,插件卡死 webchat 时一键满血——面板「更多」里也有同款
- **托盘图标固定任务栏**:启动时自动写入 Windows 通知区域设置(`IsPromoted`),图标不再每次被收进任务栏角溢出
- **任务完成通知**:会话从运行中转为空闲时弹 Windows 系统通知,带两个按钮——**「打开窗口」**(复现并聚焦窗口)和**「明白」**(收起通知);不点击则数秒后自动收起
- **链接右键菜单**:在聊天里的链接上右键,显示简洁菜单「在浏览器中打开」/「复制链接」(替换误导性的 WebView2 默认菜单);左键点击外链仍由系统默认浏览器打开
- **附加模式**:启动时若 3080 已有 DSH 在跑,直接连接不重复拉起;退出时也**不会动**别人(先于应用存在)的实例
- **干净退出**:仅托盘右键 → 「退出(关闭 DSH)」才真正退出,自动 `taskkill /T` 杀掉自己拉起的整棵进程树,零孤儿进程
- **防重复实例**:exe 被再次双击只会唤回已有窗口,不会开第二个
- **便携小巧**:单文件、无安装器、无 DLL 依赖,数据/日志写在 `%LOCALAPPDATA%\dsh-desktop\`
- **本地优先启动,npm 全局为主推荐**:按候选链自动启动 DSH——`DSH_CMD` 环境变量(失败自动降级,不再卡死)→ 自定义路径(启动页可填,永久记住)→ PATH 全局安装的 `dsh web` → 项目本地 `node_modules\.bin\dsh.cmd`(exe 同目录/工作目录/用户目录)→ 已确认过的 npx;全都找不到时启动页提供**一键全局安装**(应用直接执行 `npm install -g @deepseek-ai/dsh`,约 1-3 分钟,装完永久走最快路径、终端获得 `dsh` 命令)、npx 下载(备选)、手动填路径、重新检测、退出——不会静默下载任何东西

### 前提条件

目标机器需已具备(exe 不携带):

| 项 | 要求 |
|---|---|
| Node.js | ^22.19 或 ≥ 24(**必须**;DSH 的 Node 版本要求) |
| DSH | 可选,三种方式任一:全局安装 `npm i -g @deepseek-ai/dsh`(最快,推荐);本地安装(在 exe 旁或任意被搜索目录执行 `pnpm add @deepseek-ai/dsh`);都没有则首次启动时点「下载并启动」走 npx |
| 从源码跑 DSH 的开发者 | 设 `DSH_CMD`(`pnpm dsh web`)与 `DSH_CWD`(DSH 仓库路径)环境变量 |
| WebView2 | Windows 11 自带 |

### 快速开始

**方式一:装 DSH 插件(推荐给 DSH 用户)**

```sh
dsh plugin --profile web add dsh-desktop-plugin
```

重启 DSH 后插件自动把 exe 装到 `%LOCALAPPDATA%\Programs\dsh-desktop-windowos\`,并在桌面生成**两个**快捷方式——「DeepSeek Harness」(桌面应用)和「DeepSeek Harness Web」(浏览器打开前端);之后每次激活还会**自动升级** exe 到最新 Release(应用运行中也能安全替换)。对话里说“打开桌面应用”可通过 `desktop_launch` 工具直接拉起(exe 缺失时走**后台任务安装**,完成后自动启动,聊天里可轮询进度)。首次运行 exe 会弹 SmartScreen(未签名),点「更多信息 → 仍要运行」即可。

**插件 npm 与应用是两条独立版本线**(npm 现 1.5.10,应用现 v1.6.2,不一致是**有意设计**)——npm 只在插件代码变更时发布,内容相同的空包只会触发所有用户的插件市场更新提示与重复下载;应用走 GitHub Release 自由前进,桌面端启动时自动把已装插件对齐 npm 最新版(只升不降)。详见 [plugin/README.md](plugin/README.md)。

**方式二:直接下载 exe**

1. 从 [Releases](https://github.com/RAFOLIE/dsh-desktop-windowos/releases) 下载 `dsh-desktop-windowos-v<版本>.exe`,双击运行(免安装单文件,无需解压)。**首次运行 Windows SmartScreen 可能拦截(exe 未签名)**:点「更多信息 → 仍要运行」即可
2. 机器满足以下任一状态,双击后自动进入 webchat:
   - **已有 DSH 在跑**(如自己开过 `dsh web`)→ 自动附加,直接使用,无需 Node 在 PATH
   - **全局装了 DSH**(`npm i -g @deepseek-ai/dsh`,**推荐**)→ 启动最快,无需网络
   - **本地装了 DSH**(在 exe 同目录、工作目录或用户目录 `pnpm add @deepseek-ai/dsh`)→ 自动发现 `node_modules\.bin\dsh.cmd` 并使用
   - **之前选过「下载并启动」** → 自动经 `npx --yes @deepseek-ai/dsh web` 拉起(首选项记录在 `%LOCALAPPDATA%\dsh-desktop\settings.json`)
3. 若本地没有任何 DSH:启动页提供选择——**「一键全局安装并启动(推荐)」**(应用直接执行 `npm install -g @deepseek-ai/dsh`,约 1-3 分钟)/「下载并启动(npx,备选)」/粘贴已知 `dsh.cmd` 路径/「重新检测」/「退出」,不会未经同意就下载;需 Node.js(^22.19 或 ≥ 24)

### 构建前提(Windows)

- Rust msvc 工具链 + VS 2022 生成工具("MSVC v143 C++ 生成工具" + Windows 11 SDK)

```powershell
pnpm install        # 本项目是独立工作区根
pnpm tauri dev      # 开发模式
pnpm tauri build    # 产物:src-tauri\target\release\dsh-desktop-windowos.exe
```
> 开发提示:D 盘紧张时用 `CARGO_TARGET_DIR=C:\dsh-build-target` 把编译产物指到 C 盘;**重建前先退出正在运行的应用**(exe 被进程锁定会导致链接失败)。

### 工作原理

- Rust 侧以 `POST /api/host.describe` 探测就绪(`result.ok === true` 即就绪);启动走本地优先候选链:`DSH_CMD` 环境变量(失败自动降级)→ 自定义路径 → `dsh web`(PATH 全局)→ 项目本地 `node_modules\.bin\dsh.cmd` → 已确认过的 npx;链空则发 `notfound` 事件,启动页提供一键 `npm install -g`、npx 备选、路径输入;每个候选独立就绪窗口,失败自动降级并逐次入日志;DSH web 子进程经 `cmd /S /C` 拉起(`CREATE_NO_WINDOW`,stdout/stderr 丢弃——DSH 有自己的 `~/.dsh/logs`,壳日志只记自身事件并按会话轮转)
- 监听 `ws://127.0.0.1:3080/api/events.host`,在 `host/session-status` 的 `running` 出现 **true→false 边沿**且主窗口隐藏时,经 `session.list` 取会话标题弹通知
- 裸 exe 无安装器,Windows 会静默吞 Toast——应用启动时自动在注册表注册 AppUserModelID(`HKCU\Software\Classes\AppUserModelId\com.dsh.desktop`)保证通知可达

### 项目结构

```
src/                 React 常驻壳:自绘顶栏 + boot 视图 + webchat iframe
  EnvPanel.tsx       环境管理面板(搜索/环境|日志标签/信息卡/日志控制台)
src-tauri/src/
  dsh.rs             DSH 生命周期:探测 / spawn / 监护自愈 / 会话日志(轮转+等级)
  monitor.rs         events.host WS 监听:running 边沿 + 两按钮通知 + 断线重连
  update.rs          自更新(多路由下载+完整性校验) / 插件同步 / 完整重启
  lib.rs             托盘、窗口 X=隐藏、single-instance、AUMID 注册、面板命令
plugin/              DSH 插件(npm: dsh-desktop-plugin):自动安装/升级 exe + 双快捷方式 + desktop_launch 工具
icon-src/            图标源(DeepSeek 鲸鱼标,品牌蓝 #4D6BFE)
```

---

## English

A Windows desktop shell for DeepSeek Harness (DSH), built with **Tauri v2 + React 18 + TypeScript**.
Launch the app → it auto-starts the local DSH web service → the window embeds the native webchat in a persistent shell → tray-resident with system notifications on task completion.
Ships as a **single portable bare exe** (~4.5 MB, no installer).

**Recommended setup**: run `pnpm add @deepseek-ai/dsh` (or `npm i @deepseek-ai/dsh`) in any folder, then drop the exe into **that folder's root** and double-click — the app auto-discovers the adjacent `node_modules\.bin\dsh.cmd`: zero download, zero config, no questions asked.

### Features

- **Zero-setup**: double-click the exe and it starts DSH (`dsh web`); once ready, the window embeds the **native webchat** at `http://127.0.0.1:3080/` in a persistent same-window iframe (no custom chat UI, no reverse proxy)
- **Custom title bar**: undecorated window with the whale mark + "DeepSeek Harness" centered — **click the name to open the environment panel**; drag/min/max/close are self-drawn, native snap and edge-resize intact
- **Environment panel**: search bar (filters field names/values) + 环境|日志 tabs + four grouped fact cards (runtime / DSH kernel / component versions / storage) + bottom actions (re-detect / restart / more); copy & open-in-Explorer icon buttons; chat state survives panel visits (page behind is blurred)
- **ComfyUI-style logging**: dsh.log records only shell events (startup/supervision/updates; DSH's own output is not logged), timestamped `[INFO/WARN/ERROR]` rows with level coloring, rotated per session; a 查看日志 link on the boot page streams what the terminal is doing
- **Diagnostic bundle**: 更多 → 导出诊断信息 packs env facts + the session log into markdown on your clipboard — paste it to any AI instead of hunting through the install
- **Tray-resident**: closing the window (X) only hides it to the tray while DSH keeps running; **double-click the tray icon** or **right-click → Open DSH** brings the window back; the menu also has "重启 dsh web(后端)" (backend restart), "重启前端(完整重启)" (full app restart — the go-to when a plugin wedges things) and the update check
- **DSH supervision self-heal**: an unexpected DSH exit (market self-restart / crash) is auto-respawned and the view refreshed, no manual tray action; three consecutive quick deaths trip a crash-loop guard
- **Auto-update with progress**: while updating, a small green ring spins next to the name → check mark → **auto-restart onto the new build** (checks happen at startup only, never mid-conversation)
- **Plugin auto-sync (verified)**: at startup the installed dsh-desktop-plugin is aligned to **npm latest** (upgrade-only, cooldown bypassed); the install is then verified against node_modules, so pnpm silently keeping the old version can no longer masquerade as success
- **Tray icon pinned to the taskbar**: the app writes the Windows notification-area setting (`IsPromoted`) at startup, so the icon no longer falls into the overflow on every launch
- **Task-done notification**: when a session transitions from running to idle, a Windows toast fires with two buttons — **"Open Window"** (restore & focus) and **"Got it"** (dismiss); left untouched it auto-collapses after a few seconds
- **Link context menu**: right-clicking a link in the chat shows a clean two-item menu — "Open in browser" / "Copy link" (replacing the misleading default WebView2 menu); left-click still opens external links in the system default browser
- **Attach mode**: if DSH is already listening on 3080 at startup, the app attaches instead of spawning a second one — and never kills an instance it didn't start
- **Clean exit**: only tray right-click → "Quit (close DSH)" exits, tearing down the process tree it spawned via `taskkill /T` with zero orphans
- **Single instance**: launching the exe again just focuses the existing window
- **Portable & small**: one file, no installer, no DLL dependencies; data/logs go to `%LOCALAPPDATA%\dsh-desktop\`
- **Local-first launch, global npm as the primary recommendation**: starts DSH via a candidate chain — `DSH_CMD` env var (falls through on failure instead of stalling) → a custom path entered on the boot page (remembered) → PATH-global `dsh web` → project-local `node_modules\.bin\dsh.cmd` → a previously consented npx; when nothing local exists the boot page offers a **one-click global install** (the app runs `npm install -g @deepseek-ai/dsh` for you, ~1-3 min, permanently on the fast path with a terminal `dsh` command), the npx download as fallback, a manual path input, re-detect, and exit — nothing downloads silently

### Prerequisites (target machine)

Not bundled with the exe:

| Item | Requirement |
|---|---|
| Node.js | ^22.19 or ≥ 24 (**required**; the Node version DSH declares) |
| DSH | optional, any of: global install `npm i -g @deepseek-ai/dsh` (fastest, recommended); local install (`pnpm add @deepseek-ai/dsh` beside the exe or in any searched dir); or click "下载并启动" on first launch to go through npx |
| Running DSH from source | set the `DSH_CMD` (`pnpm dsh web`) and `DSH_CWD` (DSH repo path) env vars |
| WebView2 | included with Windows 11 |

### Quick Start

**Option A: install the DSH plugin (recommended for DSH users)**

```sh
dsh plugin --profile web add dsh-desktop-plugin
```

After restarting DSH, the plugin auto-installs the exe into `%LOCALAPPDATA%\Programs\dsh-desktop-windowos` and creates **two** desktop shortcuts — "DeepSeek Harness" (the desktop app) and "DeepSeek Harness Web" (the web UI in a browser); each later activation also **auto-updates** the exe to the latest Release (safe even while the app is running). Saying "open the desktop app" in chat launches it via the `desktop_launch` tool (a missing exe installs as a **background job** that auto-launches when done, with progress pollable in chat). First run of the unsigned exe shows SmartScreen — click "More info → Run anyway". **The plugin npm and the app run on two independent version lines** (npm currently 1.5.10, app currently v1.6.2 — the mismatch is deliberate): npm publishes only when the plugin code changes, since identical empty packages would just trigger update prompts and re-downloads for every plugin user; the app advances freely via GitHub Releases, and the desktop app aligns installed plugins to npm latest (upgrade only). See [plugin/README.md](plugin/README.md).

**Option B: download the exe directly**

1. Download `dsh-desktop-windowos-v<version>.exe` from [Releases](https://github.com/RAFOLIE/dsh-desktop-windowos/releases) and double-click it (single portable file, no unzip needed). **Windows SmartScreen may warn on first run (the exe is unsigned)**: click "More info → Run anyway"
2. Any of these machine states works — the app auto-enters the webchat after launch:
   - **DSH already running** (e.g. you started `dsh web` yourself) → auto-attach, works immediately, no Node needed on PATH
   - **DSH installed globally** (`npm i -g @deepseek-ai/dsh`, **recommended**) → fastest launch, no network needed
   - **DSH installed locally** (`pnpm add @deepseek-ai/dsh` beside the exe, in the working dir, or the user profile) → `node_modules\.bin\dsh.cmd` is discovered and used
   - **"Download" picked before** → DSH auto-starts via `npx --yes @deepseek-ai/dsh web` (choice persisted in `%LOCALAPPDATA%\dsh-desktop\settings.json`)
3. With no local DSH at all: the boot page offers — **"一键全局安装并启动" (one-click global install, recommended; the app runs `npm install -g @deepseek-ai/dsh` itself, ~1-3 min)** / "下载并启动" (npx fallback) / paste a known `dsh.cmd` path / "重新检测" (re-detect) / "退出" (exit). Nothing downloads without consent; Node.js ^22.19 or ≥ 24 is required

### Building (Windows)

- Rust msvc toolchain + VS 2022 Build Tools ("MSVC v143 C++ build tools" + Windows 11 SDK)

```powershell
pnpm install        # this project is its own workspace root
pnpm tauri dev      # dev mode
pnpm tauri build    # output: src-tauri\target\release\dsh-desktop-windowos.exe
```
> Dev tips: point `CARGO_TARGET_DIR` at a roomier drive if needed, and **quit the running app before rebuilding** (a running exe locks the linker output).

### How it works

- The Rust side probes readiness via `POST /api/host.describe` (`result.ok === true`); launch runs a local-first candidate chain: `DSH_CMD` env var (first candidate, falls through on failure) → custom path from the boot page (persisted in `settings.json`) → `dsh web` (PATH-global, checked via `where dsh`) → `node_modules\.bin\dsh.cmd` (exe dir / working dir / user profile) → a previously consented `npx --yes @deepseek-ai/dsh web`; an empty chain emits `notfound` and the boot page offers a one-click `npm install -g` (run by the app), the npx fallback, and a manual path input — each candidate has its own readiness window, falls through on failure with every attempt logged; the DSH web child is spawned via `cmd /S /C` (with `CREATE_NO_WINDOW`; its stdout/stderr is discarded — DSH keeps its own logs under `~/.dsh/logs`, and the shell log records only shell events, rotated per session)
- It listens on `ws://127.0.0.1:3080/api/events.host`; on a **true→false edge** of `running` in `host/session-status` while the window is hidden, it resolves the session title via `session.list` and fires the toast
- A bare exe has no installer, so Windows would silently drop toasts — the app registers its AppUserModelID in the registry at startup (`HKCU\Software\Classes\AppUserModelId\com.dsh.desktop`) to make notifications work
