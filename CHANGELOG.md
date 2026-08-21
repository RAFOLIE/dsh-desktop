# Changelog

## v1.6.8 — 2026-08-21

适配:**DSH rc.8 的 `dsh web` 自动打开浏览器**——桌面壳自己就显示 webchat,再弹浏览器是多余的。

- 启动候选构建时探测 `<dsh> web --help`:认得 `--no-open`(rc.8+)才追加该参数——老版本遇未知参数会拒启,探测保证 rc.6/rc.7 零影响;探测结果按路径缓存每会话一次
- 自定义路径/PATH 全局/本地安装三类候选全部覆盖;DSH_CMD 用户自管命令不改写;npx 回退路径不追加(探测代价高且当前 npm latest=rc.7 追加即拒启)

Adapts to DSH rc.8 auto-opening the browser on local `dsh web`: the flag is probed via `--help` per resolved dsh and only appended when supported (older builds reject unknown options).

## v1.6.7 — 2026-08-19

改名:「重启前端(完整重启)」→「**前后端重启**」——托盘小图标一眼能懂它前后端都会重启(v1.6.6 起行为已如此:无条件清空 3080 后换新进程);面板「更多」同款改名,确认框文案同步。

Rename: the full restart is now labeled 前后端重启 (tray + panel), matching what it actually does since v1.6.6.

## v1.6.6 — 2026-08-19

修复:**「重启前端(完整重启)」对附加模式的外部后端无效**。插件市场显示「已安装,重启后生效」,用户点了完整重启却始终未生效——完整重启此前只杀自己拉起的 DSH,3080 上的外部实例原样存活,新前端起来后附加回旧后端,新插件永远不加载。

- 新增 `stop_backend()`:teardown 自有子进程 + **无条件清空 3080 监听**(外部实例一并),完整重启改走此路径;托盘「重启 dsh web(后端)」同逻辑复用
- 完整重启后新实例必走全新启动链 → 新装插件被新后端加载,「重启后生效」名副其实

Fix: full app restart left attached external backends alive — freshly installed plugins stayed in 「重启后生效」 limbo.

- new stop_backend(): owned teardown + unconditional 3080 listener clear; full restart now uses it (backend restart reuses the same path)

## v1.6.5 — 2026-08-19

修复:**F5 后卡启动页**。F5 只刷新前端壳页面(后端不动),但 v1.6.2 常驻壳架构下新页面错过了启动时的 `ready` 事件——后端明明在跑,界面却永远停在「正在启动 DSH…」。

- 页面加载完成时重报当前后端状态(探测 3080 → 重发 `ready`(含正确的 attached 归属));与正常启动流程幂等合流
- 后端不在时应答时不发明状态,仍交给启动/监护流程

Fix: F5 left the shell stuck on the boot spinner. F5 reloads the frontend page only, but the fresh page missed the original ready emit.

- on page load the shell re-announces the current backend state (probe → re-emit ready with correct attached ownership), idempotent with normal startup

## v1.6.4 — 2026-08-18

修复:**settings.yaml 自愈**(2026-08-18 23:33 实机复现,Web UI 序列化器把 `reasoningEfforts:max` 写成缺空格的非法 YAML,热重载崩溃循环,窗口无内容无限重启)。

- **文件级自愈**:候选进程早退时 parse 检查 `~/.dsh/settings.yaml`——解析失败且仅需为 `key:` 后补空格时:先备份(`settings.yaml.dshbak`)→修复→**round-trip 验证(parse 通过才落盘)**→原地重试候选;修复无效则 ERROR 给出手动编辑路径,绝不写回非法文件
- 修复仅动 `key:value` 缺空格行,`|`/`>` 字面块内容不碰;每会话至多一次
- 崩溃可见性(stderr 尾部进窗口/日志)由 v1.6.3 提供——本次实机观察在 1.6.3 生效前
- 根因在 @linxin666/dsh-web-ui-all 0.2.0 的 YAML 序列化器(裸标量值未按 `key: value` 输出),建议反馈上游

Fix: settings.yaml self-heal (real incident 23:33 — the web UI's serializer wrote `reasoningEfforts:max` with no space, hot-reload crash-looped dsh web behind an empty window).

- On candidate early-exit the shell parse-checks settings.yaml; when the only fix needed is colon spacing it backs up, repairs, **verifies by parsing before writing back**, and retries the candidate in place; unrepairable files get an ERROR with the manual path — invalid YAML is never written
- Only `key:value` lines are touched; literal blocks (|/>) are preserved; once per session

## v1.6.3 — 2026-08-18

修复:插件同步虚报成功 / 崩溃无感知 / 冷却期连锁故障(来自 2026-08-18 晚家用机真实故障复盘)。

- **sync 验真**:安装命令 exit 0 不再视为成功——回读 profile 的 node_modules 版本,未达目标即 WARN+重试一次+冷却期指引(手动命令/等 24h);顺带跳过 pnpm workspace 级的 `profiles/node_modules` 伪 profile
- **崩溃可见性**:DSH 子进程 stdout/stderr 改为**有界内存尾部**(60 行,仍不写日志文件)——进程提前退出/监护熔断时,真实死因(如 `cannot resolve profile bundle "..."`)以 ERROR 入日志并附进启动页错误消息,附手动修复命令与日志路径;再无"快捷方式坏了"式静默循环
- **bundle 缺失自动修复**:识别 `cannot resolve profile bundle "<pkg>"` 签名 → 在 web profile 用 pnpm 带 `--config.minimumReleaseAge=0` 补装(每会话至多一次,300s 上限,包名严格白名单校验)→ 成功则原地重试该候选
- **启动链绝对路径**:PATH 命中 dsh 后用 where 解析的绝对路径拼命令(candidates 与 dsh_cli_command),不再裸 `dsh` 依赖 cmd 在 GUI 环境下的二次 PATH 解析;pnpm 同理(where→%APPDATA%
pm 回退)
- 已知未修(非本仓库):dsh CLI 的 --save-exact 自动追加 minimumReleaseAgeExclude 疑似回归(08-16 有效、08-18 失效),建议反馈 dsh 仓库

Fixes: false-success plugin sync / silent crash loops / cooldown cascade (from a real 2026-08-18 home-machine incident).

- sync now verifies the install by re-reading node_modules (pnpm's fresh-release cooldown silently keeps the old version with exit 0); WARN + one retry + cooldown guidance on mismatch; skips the workspace-level pseudo-profile
- crash visibility: the DSH child's stdout/stderr feed a bounded in-memory tail (60 lines) — real death causes land in the log as ERROR and in the boot error view with a manual fix command and log path
- auto-repair: a `cannot resolve profile bundle "<pkg>"` signature triggers a cooldown-bypassed pnpm add into the web profile (once per session, 300s cap, strict name whitelist), then retries the candidate
- launcher uses absolute dsh/pnpm paths (where + npm-global fallback) instead of bare names that depend on GUI-env PATH re-resolution

## v1.6.2 — 2026-08-18

新功能:**自绘标题栏**——顶栏常驻,点名字开环境信息(iframe 常驻壳架构)。

> 注:本条目按当日迭代顺序记录(面板经历了 基础版→完整版→精简版)。
> **最终形态**:顶栏=鲸鱼+名字(无版本胶囊);面板=搜索栏+环境|日志两标签+四组信息卡+底部 刷新检测/重启/更多;日志按会话轮转只记壳事件。

- 系统标题栏移除(`decorations: false`),由应用自绘整条顶栏:logo + 「DeepSeek Harness」可点名字(点击展开/收起环境面板) + 版本胶囊(更新圆环/对勾状态机迁入顶栏,全程可见) + 拖拽区 + 最小化/最大化/关闭按钮(关闭仍隐藏到托盘)
- **架构**:壳不再 `location.replace` 跳转到 webchat——webchat 改为跑在同窗 iframe 里(实测 3080 响应头无 X-Frame-Options/CSP,可嵌入)。壳的前端从此常驻:boot 视图 ↔ 聊天 ↔ 环境面板全在页内切换,聊天状态在环境面板期间保留
- 环境面板改为顶栏下展开的 overlay(不卸载 iframe);托盘「环境信息」经事件打开,不再靠 URL 导航
- 链接右键菜单改用 WebView2 初始化脚本注入(对所有 frame 生效,含 iframe;脚本自带 origin 守卫),原先的 45×2s 轮询注入退役
- 重启/监护自愈的"窗口交给 webchat"机制全部改为事件驱动:`ready` 事件幂等收敛为状态迁移,后端重启时 iframe 自动重载;BOOT_URL 捕获 hack 与三处 `location.replace` eval 退役
- 窗口控制(最小化/最大化/关闭/拖拽)走自定义 Rust 命令:前端窗口插件调用在本环境静默失效,而自定义命令通道稳定,Rust 侧直调不走前端 ACL
- Win+方向键贴靠/无边框边缘缩放等原生窗口机制不受影响(实测 snap 正常)
- **二级面板(Comfy Desktop 式)**:居中浮动卡片+背后网页 backdrop-blur 虚化变暗;顶部标签栏「环境 | 日志」(未来可扩展),点虚化背景或 ✕ 关闭
- 顶栏去掉版本号胶囊(身份簇=鲸鱼+名字);更新叙事保留为名字旁瞬态小环/绿勾;版本号在环境页与任务栏标题仍可查
- 环境数据**启动时预载**(ready 转移自动刷新+手动刷新)——点开面板零加载
- 新增**日志标签页**(查看日志):dsh.log 尾部 400 行等宽控制台,2 秒自动刷新(可暂停)、自动滚底、复制全部;启动页(启动中/已连接/失败)加「查看日志」入口,卡壳时能实时看到 npx 下载/启动尝试在跑什么
- 新增 Rust 命令 log_tail(50-1000 行 clamp)
- **日志 ComfyUI 化**:①只记壳自身事件——DSH web 子进程输出改为丢弃(DSH 有自己的 ~/.dsh/logs,不再重复收录,日志不再膨胀);②统一 `[本地时间] [INFO/WARN/ERROR] 消息` 格式(GetLocalTime 原生 FFI,零依赖);③每次启动把旧日志轮转成 `dsh.log_<时间戳>.log`(留最新 20 个),新会话从 `** session/app` 横幅开始;④日志 tab 逐行着色(横幅蓝/WARN 琥珀/ERROR 红)
- **诊断包**:环境 tab 新增「复制诊断包」——一键把 env_info 全部事实+本次会话日志组装成 markdown,复制到剪贴板+存为 diagnostics-<时间戳>.md 并打开目录;以后问 AI 配置/启动问题直接粘贴,AI 无需翻 DSH 前端目录与全局安装
- 环境探测(node/powershell)加无窗口标志,启动时不再闪终端
- **环境管理面板 v2**(按详细规格书重构):搜索栏(过滤实例与字段)+筛选栏(全部/本地/外部/运行中/异常)+左侧实例栏(唯一真实实例,状态圆点+当前标签+蓝指示条)+右侧标签导航(环境/日志可用,启动参数/存储/终端/关于禁用提示暂未支持)+底部操作栏(刷新检测带 loading/重启后端带确认/更多下拉:打开工作目录·日志目录·复制环境 JSON·导出诊断包;新增实例禁用)
- 环境页四组(运行状态/DSH 内核/组件版本/位置与存储):主功能标题在卡片外上方+每组合一个大圆角卡,行间细线,行=名称/值/图标按钮(30px 复制⧉·打开目录📁,aria-label,已复制 Toast)
- env_info 新增:日志目录、工作目录、缓存目录(未检测到)、Profile 磁盘占用(有界遍历≤5万文件)
- 日志页迁入标签:INFO/WARNING/ERROR 筛选胶囊、暂停/恢复自动刷新、复制全部、清空显示(仅前端)、跳到最新、上滚自动暂停跟随
- 交互:Esc/遮罩/✕ 三路关闭、打开焦点进搜索框关闭还原到名字按钮、focus 蓝描边、<1100px/<900px 响应式(单栏+行上下结构)
- 新命令 dsh_restart_backend(真实重启 dsh web,同托盘);**重启前端(完整重启)**:托盘与面板「更多」双入口,relaunch helper 需 arm 成功才退出(防"重启变退出"),连壳带后端全新拉起——插件卡死 webchat 时一键满血
- 启动文案去黑话:删「已连接(附加到已有实例)」;DSH_CMD→自定义启动命令、npx --yes @deepseek-ai/dsh web→npx 下载并启动
- **面板精简**(第二版规格):移除筛选工具栏(打开仪表板/全部/本地/外部/运行中/异常)、左侧实例栏(实例列表/当前标签/新增实例)、四个禁用标签(启动参数/存储/终端/关于)——只留 环境|日志 两标签;主体单栏满宽(卡片内容上限 1400px 居中),搜索只过滤环境字段(占位改「搜索环境信息」),底栏右对齐只留 刷新检测/重启/更多;删除全部配套前端状态与样式

Feature: a custom in-app title bar — always visible, click the name to open the env panel (persistent-shell iframe architecture).

- The native title bar is gone (`decorations: false`); the app draws its own: logo, a clickable name (toggles the env overlay), the version pill with the update ring/check story (now visible in chat too), a drag region, and min/max/close (close still hides to tray)
- The shell no longer navigates away to the webchat — it runs in a same-window iframe (3080 serves no frame-blocking headers, verified). Boot ↔ chat ↔ env are in-page views now; chat state survives env-panel visits
- The env panel is an overlay sliding under the title bar (iframe stays mounted); the tray entry opens it via event instead of URL navigation
- The webchat link context menu now rides along as a WebView2 initialization script (runs in every frame, origin-guarded); the old 45×2s poll-inject is retired
- Restart/supervision handoff is event-driven: `ready` re-emits collapse into transitions, the iframe auto-reloads when the backend restarts; the BOOT_URL capture hack and three `location.replace` evals are gone
- Window controls (min/max/close/drag) go through custom Rust commands — the frontend window-plugin calls silently no-op'd here while the custom-command channel is rock solid, and Rust-side calls bypass the frontend ACL entirely
- Native window behaviors (snap, undecorated edge resize) are unaffected (snap verified live)
- Secondary panel (Comfy-Desktop-style, iterated to its final simple form): search bar + 环境|日志 tabs + four grouped fact cards (titles above one big card each, hairline rows, copy/open-dir icon buttons, toasts) + bottom re-detect / restart / more; the chat stays blurred behind; env data prefetched at startup
- ComfyUI-style session log: shell events only (DSH's own output discarded), `[local-time] [INFO/WARN/ERROR]` colored rows, rotated per session (20 kept), a 查看日志 link on the boot page; log tab has level filters / follow / clear-display / jump-to-latest
- Diagnostic bundle: 更多 → 导出诊断信息 packs env facts + the session log as markdown to clipboard and a file — one paste gives any AI the full picture
- Full app restart (重启前端): tray + panel entry, helper must arm before exit; shell and backend both restart fresh
- env_info gains logDir/workspaceDir/cacheDir/profileSizeBytes; plain-language boot text; windowless env probes

## v1.6.1 — 2026-08-17

新功能:**环境面板**(模仿 Comfy Desktop 的 StatusFactPanel,秋叶启动器式自用诊断)。

- 启动页左上角「DeepSeek Harness」名字**可点击**进入二级环境页;托盘右键新增「**环境信息**」随时从聊天页进入(带「返回聊天」)
- 环境页分区展示真实数据(Comfy Desktop 式标签在上/值在下+发丝线+复制按钮+路径可打开目录):
  - **运行状态**:3080 应答、占用进程 PID/命令行/父链、归属(本应用子进程受监护 / 外部实例)
  - **DSH 内核**:where dsh、自定义路径、本地安装、DSH_CMD/DSH_CWD 残留、npx 回退、插件版本(dsh-desktop-plugin/dshmarket)、Profile 目录
  - **Node 环境**:实际 node 路径+版本——一眼看清是不是 ComfyUI 等其它软件带的 node
  - **本应用**:版本、安装目录
  - **日志**:dsh.log 尾部 25 行控制台窗格
- 全部数据采集独立降级(单项失败显示 —,页面永不卡死)

Feature: an environment panel (modeled on Comfy Desktop's StatusFactPanel) for self-serve diagnostics.

- The boot page's top-left name is now clickable into an env page; a new tray 「环境信息」 entry opens it any time from the webchat (with a back-to-chat button)
- Sectioned real facts with copy buttons and open-in-Explorer for paths: DSH runtime (port, pid, command line, ownership chain), kernel chain (where dsh, custom path, env leftovers, plugin versions, profile dir), Node (actual path + version — spot when it belongs to ComfyUI or another AI app), the app itself, and a dsh.log tail console
- Every probe degrades independently (missing facts show "—", the page never hangs)

## v1.6.0 — 2026-08-17 — 2026-08-17

新功能:桌面壳成为 DSH 的**监护进程(supervisor)**——DSH 意外退出自动愈合。

- **背景**:dshmarket 更新自身时会杀掉并复刻 DSH 进程(其自重启机制),复刻进程脱离桌面壳监管;DSH 崩溃时窗口对着死页面——都需要人肉托盘重启。市场文档明确:"有 supervisor 的部署应由 supervisor 接管重启"
- **监护**:壳持有 DSH 子进程句柄专职看护;意外退出(市场自重启/崩溃)→ 等 2.5s 让市场的复刻进程落地 → 清 3080 端口(杀掉孤儿复刻) → 按启动链重拉自己的 DSH → 窗口强制刷新重连;正常退出(托盘重启/退出应用)不误触发
- **防崩溃循环**:连续 3 次存活不足 30 秒即停止自动重启,报错到启动页并提示用托盘手动重试
- 真机验证:手动杀 DSH 与触发市场自重启端点两种场景均自动愈合,3080 归属恢复为壳的子进程

Feature: the desktop shell is now a proper DSH supervisor — unexpected DSH exits heal automatically.

- dshmarket's self-update kills and re-spawns the DSH host outside our supervision, and a DSH crash left the window on a dead page; both needed a manual tray restart. The shell now watches its child: on unexpected exit it lets the market's raced replacement land, clears port 3080 (killing the orphan), respawns its own DSH, and force-reloads the window. Intentional exits (tray restart / app quit) don't trigger it; three consecutive sub-30s lives trip a crash-loop guard that stops auto-respawning and surfaces an error.

## v1.5.12 — 2026-08-16 — 2026-08-16

加固:更新失败全程可见 + 卡死路由快速放弃。

- curl 增加 `--speed-time 30 --speed-limit 1024`:低于 1KB/s 持续 30 秒即判死放弃该路由(今天实测"连上但卡死"的直连会烧满 120 秒)
- 启动检查/托盘检查的**任何失败现在写入 dsh.log**(原先只 eprintln,GUI 程序里不可见,导致无声失败难排查)

Hardening: visible update failures and fast stall abandonment.

- curl gains `--speed-time 30 --speed-limit 1024` — a route flowing under 1KB/s for 30s is abandoned instead of burning the full 120s
- Every launch/tray check failure now lands in dsh.log (was eprintln-only, invisible in a GUI app)

## v1.5.11 — 2026-08-16 — 2026-08-16

改进:更新下载链覆盖三类网络用户(国外直连/国内镜像/代理探测),镜像传输带完整性校验。

- **路由链(按序尝试,全部快速失败)**:直连(国外用户秒过)→ 环境变量代理(HTTPS_PROXY/HTTP_PROXY/ALL_PROXY)→ **本机代理端口探活**(7890/7891/**7897**/7898/10808/10809,覆盖 Clash/v2rayN;7897 为真机踩坑新增)→ **公共镜像**(ghproxy.com / gh-proxy.com / ghfast.top,纯国内无代理用户兜底)
- **完整性校验**:下载结果用 GitHub API 自带的资产 size+sha256 digest 验证,不匹配丢弃换下一路由——公共镜像被投毒/截断自动免疫
- **API 请求也走代理链**(api.github.com 直连失败自动走代理);每跳 --connect-timeout 8 快速失败
- 插件(installer.ts)同步改造(fetchBytes 走全链+verify 闭包,25/25 测试绿),npm 按隔一天政策随下次窗口发布
- 应用侧 v1.5.11(GitHub Release)

Improvement: the download chain now serves three user profiles (overseas direct / China mirror / proxy probe), with integrity verification for mirrored transfers.

- Ordered route chain with fast failure: direct → env proxies → probed local ports (7890/7891/7897/7898/10808/10809) → public mirrors (ghproxy.com / gh-proxy.com / ghfast.top)
- Integrity: every transfer is verified against the API's own size + sha256 digest; mismatches are discarded and the next route tried
- The API call itself falls back through proxies; plugin (installer.ts) rebuilt with the same chain (25/25 tests), npm ships at the next publishing window per policy

## v1.5.10 — 2026-08-16 — 2026-08-16

改进:一键安装自动选 npm 源(测速:官方 vs 国内镜像)。

- 未找到 DSH 时,启动页**并行测速** registry.npmjs.org 与 registry.npmmirror.com(各 4 秒超时,拉 @deepseek-ai/dsh 的 /latest 元数据)
- 主按钮自动选**最快源**并显示毫秒数(如「已选最快:国内镜像 23ms」),另一个源保留为次按钮「改用官方源安装(210ms)」
- 两个源都不通时回退普通安装命令(走用户 npm 配置);Rust 侧白名单只允许这两个 registry 进入命令行
- 应用侧改动,插件 npm 不发布(按需发布政策)

Improvement: the one-click install auto-picks the npm registry by speed.

- On notfound, the boot page probes registry.npmjs.org vs registry.npmmirror.com in parallel (4s timeout each, fetching the package /latest metadata)
- The primary button uses the faster source with its ms figure ("已选最快:国内镜像 23ms"); the other stays as a secondary button with its own timing
- When both are unreachable the plain install command runs (user's npm config); Rust whitelists exactly those two registries into the command line
- App-only change; no npm publish under the on-demand policy

## v1.5.9 — 2026-08-16 — 2026-08-16

改进:应用与插件 npm 版本线解耦 + 合并社区 PR #1。

- **版本策略变更**:应用版本自由前进(本版起 GitHub Release 即完成发布);**插件 npm 包仅在功能变更时发布**,不再逐版对齐——桌面端启动时自动把已装插件对齐 **npm 最新版**(只升不降,而非应用版本号)
- **PR #1(q6913781,已合并)**:①Cargo.toml 显式声明 `custom-protocol` feature——修复手动 `cargo build --release` 以 dev 模式启动(webview 连 localhost:1422 被拒);②`ready` 事件 4 秒内重发 10 次——修复附加模式下事件早于启动页监听器注册被丢、卡死在"正在启动…"的竞态

Improvement: app and plugin npm version lines decouple; community PR #1 merged.

- **Versioning change**: the app version now advances freely (a GitHub Release completes a publish); **the plugin's npm package ships only when the plugin actually changes** — the app now aligns installed plugins to **npm latest** (upgrade-only), not to the app's own version
- **PR #1 (q6913781, merged)**: declares the `custom-protocol` feature (fixes manual `cargo build --release` booting in dev mode, webview refusing localhost:1420) and re-emits `ready` for 4s (fixes the boot page missing the one-shot event and hanging on "正在启动…")

## v1.5.8 — 2026-08-16 — 2026-08-16

加固:自动重启链路三处防御性修复(真机排查 1.5.6→1.5.7 更新不生效时发现)。

- **重启助手换延时实现**:`timeout /t` 在部分 PATH 下被 GNU timeout.exe 抢占导致助手秒死,改用 `ping -n 4`(永远指向 System32)+ `start "" "exe"` 引号稳妥启动(两种形式均已单独验证)
- **插件包同步移出更新路径**:换装完成后立即重启,同步交给新进程启动时的检查路径——挂死的 pnpm 再也不可能堵在"换装"和"重启"之间
- **同步加 120 秒硬超时**:超时杀进程记日志,下次启动重试

Hardening: three defensive fixes around the auto-restart chain (found while live-debugging a 1.5.6→1.5.7 update that never activated).

- The relaunch helper's `timeout /t` delay loses to a GNU timeout.exe on some PATHs and dies instantly; it now uses `ping -n 4` (always System32) with the `start "" "exe"` launcher (both forms verified standalone)
- The plugin-package sync no longer runs between the exe swap and the restart — the new process's launch check performs it, so a hung pnpm can never stall the restart
- The sync gains a 120s hard kill timeout with a logged retry-next-launch

## v1.5.7 — 2026-08-16 — 2026-08-16

修复:更新下载在 GitHub CDN 不通时静默失败(应用侧与插件侧同修)。

- **根因**:GitHub 发行资产经 objects.githubusercontent.com 分发,本网络环境下时通时断——API 检查正常(能发现新版)、下载却 0 字节超时,失败后无任何提示直接进 webchat,用户以为"更新完了"实际版本没变,反复重开反复"更新"
- **修复①(两级下载)**:资产下载直连失败后,自动依次尝试代理:环境变量 HTTPS_PROXY/https_proxy → 本机常见代理端口 7890/7891(先 1 秒探活);应用侧(Rust)与插件侧(Node)同修
- **修复②(失败可见)**:更新失败不再静默——启动页显示「应用更新失败(网络),已跳过——下次启动自动重试,或稍后用托盘『检查前端更新』」,停留 4 秒再进入网页
- **加固**:自动重启助手改用 `start "" "exe"` 引号稳妥模式并记录日志

Fix: update downloads failed silently whenever GitHub's CDN was unreachable (fixed on both the app and plugin sides).

- **Root cause**: release assets ship via objects.githubusercontent.com, intermittently blocked here — the API check succeeds (a new version is found) while the download times out at 0 bytes; the failure was swallowed and the app fell straight into the webchat, looking "updated" without changing
- **Fix 1 (two-tier download)**: after a direct download fails, retry through proxies in order — HTTPS_PROXY/https_proxy env → common local ports 7890/7891 (1s liveness probe first); applied to both the Rust app updater and the Node plugin installer
- **Fix 2 (visible failures)**: a failed update now shows a notice on the boot page for 4 seconds ("应用更新失败(网络),已跳过…") instead of silently proceeding
- Hardening: the relaunch helper uses the quote-proof `start "" "exe"` pattern and logs its arming

## v1.5.6 — 2026-08-16 — 2026-08-16

改进:托盘菜单更名 + 新增「检查前端更新」。

- 「重启 DSH」更名 **「重启 dsh web(后端)」**——它只重启网页后端,旧名容易被理解为"也会更新前端"(实际更新只在应用启动时检查)
- 新增托盘菜单 **「检查前端更新」**:随时手动触发应用自更新检查;无更新弹通知「前端已是最新版本 v{当前}」,有更新则通知「正在下载/已更新到 v{新},正在重启…」并走既有自动重启(含插件包同步);连点菜单有防重入保护

Improvement: tray menu rename plus a new "check for frontend update" entry.

- "重启 DSH" is renamed **"重启 dsh web(后端)"** — it only restarts the web backend; the old name invited reading it as "this also updates the app" (updates actually only check at app launch)
- New tray item **"检查前端更新"**: trigger the app self-update on demand; toasts narrate "已是最新 v{current}" / "正在下载" / "已更新到 v{new},正在重启…" and the existing auto-restart (with plugin sync) follows; repeated clicks are guarded against re-entry

## v1.5.5 — 2026-08-16 — 2026-08-16

改进:版本胶囊的更新指示改为绿色缺口圆环旋转。

- 原 Win11 六点旋转样式改为**绿色环形缺一小段、整体旋转**(SVG 圆环 stroke-dasharray,约 30/38 弧长 + 圆头端点),视觉更简洁连贯

Improvement: the pill's update spinner becomes a rotating green ring with a small gap.

- The Windows 11 six-dot style is replaced by a **green ring missing a small segment, rotating as a whole** (SVG circle stroke-dasharray, ~30/38 arc with round caps) — simpler and more continuous

## v1.5.4 — 2026-08-16 — 2026-08-16

改进:更新完成后应用**自动重启**,新版本即刻生效。

- **背景**:自动更新换的是磁盘上的 exe,正在运行的进程仍是旧代码(窗口的拖放等设置在创建窗口时已固定)——旧版必须完全退出重开才能用上新功能,托盘「重启 DSH」只重启后端帮不上忙
- **修复**:更新完成(绿勾展示后)应用自动重启到新 exe:分离的辅助进程等旧进程退出(释放单实例锁)后拉起新 exe;退出时**不**停 DSH 后端,新实例直接附加,网页聊天无感续连
- 更新只发生在启动时,自动重启永远在"刚打开应用"阶段,绝不会打断进行中的对话;重启失败时启动页 8 秒兜底直接进入网页

Improvement: the app now **auto-restarts** after an update so the new build takes effect immediately.

- **Background**: the auto-update swaps the exe on disk while the running process keeps the old code (window-level settings like drag-drop are fixed at window creation) — the fix only activated after a full manual restart, which made the tray "重启 DSH" (backend-only) useless for this
- **Fix**: once the update lands (after the green check), the app relaunches onto the new exe: a detached helper waits for the old process to exit (releasing the single-instance lock) and starts the new build; the exit deliberately skips DSH teardown so the new instance attaches to the still-running webchat
- Updates only ever run at launch, so the auto-restart never interrupts an ongoing conversation; if the restart fails, the boot page falls back to the webchat after 8 seconds

## v1.5.3 — 2026-08-16 — 2026-08-16

修复:桌面端无法拖放文件进前端(浏览器正常)。

- **根因**:Windows 上 WebView2 默认的拖放处理器会把文件拖拽事件整个吞掉,页面收不到 HTML5 drop 事件——Tauri 官方文档要求必须 `disable_drag_drop_handler()` 才能启用浏览器级拖放
- **修复**:窗口构建时禁用默认拖放处理器 + 开启页面剪贴板访问(`enable_clipboard_access`,粘贴截图同通道)
- 修复后与浏览器行为完全一致:可拖入 **png / jpg / webp / gif** 四种图片(DSH 附件 v1 仅支持这四种,从解码字节校验);PDF/文本/视频需走会话内文件读取工具

Fix: files could not be dragged into the in-app webchat (works in a browser).

- **Root cause**: on Windows, WebView2's default drag-drop handler swallows file drops before the page sees them — the tauri-documented requirement is to disable that handler for browser-parity HTML5 dnd
- **Fix**: disable the default drag-drop handler and enable page clipboard access (`enable_clipboard_access`, same channel for pasted screenshots) on the window builder
- After the fix drag-and-drop behaves exactly like a browser: **png / jpg / webp / gif** images are accepted (the DSH v1 attachment path supports exactly these four, verified from decoded bytes); PDFs/text/videos go through the in-chat file-reading tools instead

## v1.5.2 — 2026-08-14 — 2026-08-14

改进:应用更新后自动同步插件包版本,市场不再反复提示"重新下载"。

- **背景**:pnpm 的供应链安全冷却期(minimumReleaseAge,约 26 小时)会拒绝或静默跳过刚发布的插件版本——市场点更新→pnpm 拿旧版→版本没变→继续提示→循环重下(dshmarket #13/#22 已确认此机制)
- **修复**:应用自更新检查收敛后(无更新/更新完成),自动扫描所有**已装有** dsh-desktop-plugin 的 DSH profile,用 `dsh plugin add dsh-desktop-plugin@<应用版本> --config.minimumReleaseAge=0`(市场「立即更新」同款一次性旁路)把插件包对齐到应用版本线
- 未安装插件的 profile 绝不主动安装;版本已齐时零 pnpm 调用;失败只记日志下次再试,不影响启动;同步日志写入 dsh.log

Improvement: after the app updates, the npm plugin package syncs to the same version — the market stops offering a re-download loop.

- **Background**: pnpm's supply-chain fresh-release hold (minimumReleaseAge, ~26h) rejects or silently skips a just-published plugin version — market update → pnpm keeps the old one → version unchanged → the market keeps offering → retry loop (confirmed by dshmarket issues #13/#22)
- **Fix**: once the self-update check settles (none or done), the app scans every DSH profile that ALREADY has dsh-desktop-plugin and pins it to the app's version via `dsh plugin add dsh-desktop-plugin@<version> --config.minimumReleaseAge=0` (the same one-shot bypass the market's "update now" uses)
- Profiles without the plugin are never touched; steady state spawns nothing; failures only log to dsh.log and retry next launch

## v1.5.1 — 2026-08-14 — 2026-08-14

改进:启动页左上角新增应用名 + 版本胶囊,应用自更新全程可见。

- **版本胶囊**:启动页左上角显示「DeepSeek Harness」与椭圆包裹的版本号;窗口标题栏同步带上版本(进入 webchat 后仍可见)
- **应用自更新**(新增,Rust 侧):每次启动并行检查 GitHub 最新 Release,有新版则下载换装(rename-aside,运行中安全),与插件更新逻辑同源
- **更新指示**:更新期间版本号右侧显示 Win11 开机风格的绿色点状旋转圈(胶囊内);完成变为绿色对勾,约 1.8 秒后淡出,恢复纯版本号(显示新版本)
- **更新优先展示**:DSH 就绪但更新仍在进行时,暂缓跳转 webchat,显示「正在更新应用…完成后自动进入」;无更新零等待,事件异常 10 秒保险丝放行

Improvement: the boot page gains a top-left app name + version pill, and the app's self-update becomes visible.

- **Version pill**: top-left shows "DeepSeek Harness" with an ellipse-wrapped version number; the window title bar carries the version too (visible after the webchat handoff)
- **App self-update** (new, Rust side): each launch checks the latest GitHub Release in parallel and swaps the exe aside when one exists (rename-aside, safe while running) — same approach as the plugin updater
- **Update indicator**: while updating, a green Windows 11 boot-style dotted spinner spins inside the pill next to the version; on completion it becomes a green check that fades out after ~1.8s, leaving the (new) version
- **Update-first handoff**: when DSH is ready but an update is still in flight, the webchat handoff waits with a "正在更新应用…完成后自动进入" note; zero wait when there is no update, and a 10s fuse guarantees startup never hangs

## v1.5.0 — 2026-08-14 — 2026-08-14

改进(插件):desktop_launch 对齐官方文档三大升级——后台安装、UI 卡片、免模型集成测试。

- **后台安装**:`desktop_launch` 在 exe 缺失时改走 `ctx.jobs` 后台任务(kind `desktop`)——下载 exe → 刷新快捷方式 → 完成后自动启动,立即返回 `jobId` 供模型用标准 `job_output`/`job_list` 轮询;取消会中止进行中的 curl 下载并跳过启动。exe 已存在时仍是前台秒开;精简组合(无 jobs 服务/无 job controller)自动回退前台安装,新配置 `backgroundInstall`(默认开)可强制前台
- **UI 卡片**:补齐 `presentCall`/`presentResult`/`output.presentationMeta` 投影——挂起态显示「启动 DSH 桌面端」execute 卡片,完成态按状态显示「桌面端已启动/后台安装已开始/仅支持 Windows」,回放可重现
- **输出 schema 升级**:`{launched, exePath}` → `{status: launched|installing|windows-only, exePath?, jobId?}`,渲染文本指导模型轮询后台任务
- **集成测试**:新增 6 个测试用真实 ToolRuntime + LocalJobRegistry + tool-jobs 组合免模型驱动完整工具流水线(含后台分支端到端:下载→jobId→completed→启动),共 22/22 全绿

Improvement (plugin): desktop_launch aligns with the official docs' three upgrades — background install, UI cards, and model-free integration tests.

- **Background install**: when the exe is missing, `desktop_launch` starts a `ctx.jobs` background job (kind `desktop`) — download exe → refresh shortcuts → auto-launch on completion — returning a `jobId` immediately for the model to poll via the standard `job_output`/`job_list` tools; cancellation aborts the in-flight curl download and skips the launch. An existing exe still launches in the foreground instantly; minimal compositions (no jobs service / no job controller) fall back to an inline install, and the new `backgroundInstall` config (default on) can force the foreground path
- **UI cards**: adds the `presentCall`/`presentResult`/`output.presentationMeta` projections — a pending generic execute card ("启动 DSH 桌面端") and completion cards per status ("桌面端已启动" / "后台安装已开始" / "仅支持 Windows"), replayable
- **Output schema**: `{launched, exePath}` → `{status: launched|installing|windows-only, exePath?, jobId?}` with render text that guides the model to poll the background job
- **Integration tests**: 6 new tests drive the full tool pipeline without a model using the real ToolRuntime + LocalJobRegistry + tool-jobs composition (including the background branch end-to-end: download → jobId → completed → launched); 22/22 green

## v1.4.5 — 2026-08-15

改进:未找到 DSH 时,「npm 全局安装」升级为一键主推荐。

- 启动页新增**「一键全局安装并启动」**按钮:应用直接执行 `npm install -g @deepseek-ai/dsh`(约 1-3 分钟,日志写入 dsh.log),完成后自动重走启动链并永久走最快的全局路径(终端同时获得 `dsh` 命令)
- npx 下载降为**备选**(装进 npx 缓存,不产生 dsh 命令,每次启动有解析开销)
- 安装失败(无 Node/npm/网络问题)在启动页给出明确指引,不影响其它选项

Improvement: one-click global npm install becomes the primary recommendation when no DSH is found.

- New "一键全局安装并启动" button: the app runs `npm install -g @deepseek-ai/dsh` itself (~1-3 min, logged to dsh.log), then restarts the chain and permanently uses the fast global path (the terminal gains the `dsh` command too)
- The npx download is demoted to a fallback (npx cache only, no `dsh` command, per-launch resolution overhead)
- Install failures (missing Node/npm, network) surface clear guidance on the boot page without affecting the other options

## v1.4.4 — 2026-08-15

改进:启动页支持手动指定 DSH 路径,`DSH_CMD` 失效不再卡死启动。

- 未找到 DSH 时,启动页新增**路径输入框**:粘贴已知安装位置(如 `E:\...\dsh.cmd`)即可启动并永久记住;路径失效时自动跳过,回到正常候选链
- 本地检查顺序保持 `where dsh` 优先(覆盖 npm 全局 `dsh`/`dsh.cmd`)→ 应用/工作/用户目录的 `node_modules\.bin\dsh.cmd` → 已确认的 npx
- `DSH_CMD` 环境变量从"替换整条链"改为**首个候选**——残留失效值(如已删除的旧目录)会自动降级到后续候选,不再卡在启动页(实测案例:旧 `E:\...\node_modules\.bin\dsh.cmd` 覆盖值导致无限启动)

Improvement: manual DSH path entry on the boot page; a stale `DSH_CMD` no longer stalls startup.

- When no DSH is found, the boot page gains a **path input**: paste a known install location (e.g. `E:\...\dsh.cmd`) to start and remember it; a dead saved path is skipped automatically, falling back to the normal chain
- Local discovery order stays `where dsh` first (covers the npm-global `dsh`/`dsh.cmd`) → `node_modules\.bin\dsh.cmd` in exe/working/user dirs → consented npx
- `DSH_CMD` now leads the chain instead of replacing it — stale overrides (e.g. a deleted `E:\...\node_modules\.bin\dsh.cmd`) fall through to later candidates instead of hanging the boot page

## v1.4.3 — 2026-08-15

改进:托盘图标固定显示在任务栏,不再每次启动都被收进溢出区。

- 现象:Windows 11 按可执行文件路径识别托盘图标并默认收进任务栏角溢出,且每次启动都回到默认,不记住用户上次的摆放
- 修法:启动后在 `HKCU\Control Panel\NotifyIconSettings` 中按本程序路径匹配图标项并写入 `IsPromoted = 1`——这正是用户手动"取消隐藏"时 Windows 写入的值;注册后短暂重试(该键在托盘注册后才生成),失败不影响启动
- 注意:如确实想收起图标,可在 Windows 设置 → 任务栏 → 其他系统托盘图标 中关闭,但下次启动应用会再次固定(托盘是本应用的主界面)

Improvement: the tray icon is now pinned to the taskbar instead of falling back into the overflow on every launch.

- Cause: Windows 11 identifies tray icons by exe path under the per-icon settings and defaults to the hidden overflow, resetting the user's placement each launch
- Fix: after startup, match this exe's entry under `HKCU\Control Panel\NotifyIconSettings` and write `IsPromoted = 1` — the exact value Windows writes when a user unhides an icon; retried briefly since the key appears only after the tray registers; failures are cosmetic
- Note: to collapse the icon on purpose, turn it off in Windows Settings → Taskbar → Other system tray icons — the app re-pins on next launch (the tray is this app's main interface)

## v1.4.2 — 2026-08-14

修复:托盘「重启 DSH」后窗口未回到 webchat(DSH 本体重启成功,页面停在死页/空白页)。

- 根因 1:boot 页 URL 在窗口构建完成时捕获,而此时 webview 还停在 `about:blank`,「回到启动页」导航到了空白页
- 根因 2:启动页重新加载后若错过 `ready` 事件(页面加载慢于 DSH 启动),没人再驱动跳转,窗口永远停在转圈/死页
- 修法 1:改用 `on_page_load` 在 boot 页真正加载完成时捕获 URL(首个真实页面胜出,dev 模式同样适用)
- 修法 2:重启完成后轮询窗口 URL,DSH 已就绪而窗口 5 秒内未到 webchat 时,Rust 侧强制导航过去——任何一环掉链子都能兜住
- 体验:点击「重启 DSH」立即弹出并聚焦主窗口(原先窗口藏在托盘时重启毫无可见反馈)

Fix: after tray "重启 DSH" the window never returned to the webchat (DSH itself restarted fine, the page sat dead/blank).

- Cause 1: the boot URL was captured right after window build, when the webview still sat on `about:blank` — the "back to boot page" navigation went to a blank page
- Cause 2: if the reloaded boot page missed the `ready` event (page load slower than DSH boot), nothing else drove the handoff and the window stayed stuck
- Fix 1: capture the URL via `on_page_load` when the boot page actually finishes loading (first real page wins; works in dev too)
- Fix 2: after restart, poll the window URL — if DSH is ready but the window hasn't reached the webchat within 5s, force the navigation from Rust
- UX: clicking "重启 DSH" now shows and focuses the main window immediately (a restart triggered while hidden in the tray used to give no visible feedback)

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
