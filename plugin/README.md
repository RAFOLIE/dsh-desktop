# dsh-desktop-plugin

> **版本规则**:本插件与桌面应用共用**同一条版本线**(如插件 1.4.2 = 应用 v1.4.2);插件单独改进时版本号继续前进,始终 ≥ 应用版本。

DSH 插件:安装并启动 [dsh-desktop-windowos](https://github.com/RAFOLIE/dsh-desktop-windowos) 桌面壳(DeepSeek Harness 的 Windows 托盘应用)。

- 插件激活时自动确保桌面应用就绪:缺失则从 GitHub Releases 下载 exe 到 `%LOCALAPPDATA%\Programs\dsh-desktop-windowos\`,并在桌面创建/刷新**不带版本号**的快捷方式「DeepSeek Harness」;已存在则跳过下载
- **自动升级**:每次激活时比对已装版本与最新 Release,有新版自动下载替换(运行中也能安全替换,旧文件保留为 `.old`)
- 同时在桌面创建/刷新 `.url` 快捷方式「DeepSeek Harness Web」,用默认浏览器打开 DSH 前端(默认 `http://127.0.0.1:3080`);exe 已安装时复用其鲸鱼图标
- 注册 `desktop_launch` 工具:对话里说"打开桌面应用"即可安装并拉起, agent 可直接调用;exe 缺失时走**后台任务安装**(标准 job_output/job_list 可轮询,完成后自动启动),exe 已存在则前台秒开
- 安装/下载失败不影响 DSH 启动,错误只记录日志,下次激活或调用工具时重试

> **首次双击 exe 会弹 Windows SmartScreen 蓝色警告**("Windows 已保护你的电脑")——exe 未签名所致,点「**更多信息** → **仍要运行**"即可,以后不再弹。

## 安装

```sh
dsh plugin --profile web add dsh-desktop-plugin
```

重启 DSH(`dsh web`)后生效。要求 Windows + Node ^22.19 或 ≥ 24。

## 配置(cordis.patch.yml)

| 字段 | 默认 | 说明 |
|---|---|---|
| autoInstall | true | 激活时自动安装/刷新 |
| autoUpdate | true | 激活时检查并升级新 Release |
| assetProxy | (空) | Release 资产下载镜像前缀,如 `https://ghproxy.com/`(GitHub 直连不畅时用) |
| createShortcut | true | 创建桌面应用快捷方式 |
| createWebShortcut | true | 创建前端 Web 快捷方式(.url) |
| installDir | %LOCALAPPDATA%\Programs\dsh-desktop-windowos | exe 安装目录 |
| shortcutName | DeepSeek Harness | 快捷方式名称(无版本号) |
| webShortcutName | DeepSeek Harness Web | Web 快捷方式名称(无扩展名) |
| webUrl | http://127.0.0.1:3080 | Web 快捷方式打开的地址 |
| repoSlug | RAFOLIE/dsh-desktop-windowos | exe 的 GitHub Release 来源 |
| backgroundInstall | true | 工具装 exe 走后台任务;关闭则永远前台安装 |

# English

> **Versioning rule**: this plugin shares **one version line** with the desktop app (plugin 1.5.1 = app v1.5.1); plugin-only improvements move the number forward, always ≥ the app version.

DSH plugin that installs and launches [dsh-desktop-windowos](https://github.com/RAFOLIE/dsh-desktop-windowos) — the Windows tray shell for DeepSeek Harness.

- On activation it ensures the desktop app is ready: downloads the exe from GitHub Releases into `%LOCALAPPDATA%\Programs\dsh-desktop-windowos` when missing and creates/refreshes a version-less desktop shortcut "DeepSeek Harness"; existing installs are left alone
- **Auto-update**: each activation compares the installed version with the latest Release and swaps in the new exe when one exists (safe even while the app is running; the old file is kept as `.old`)
- It also creates/refreshes a "DeepSeek Harness Web" `.url` desktop shortcut that opens the DSH web UI in the default browser (default `http://127.0.0.1:3080`), reusing the desktop exe's whale icon when installed
- Registers the `desktop_launch` tool — say "open the desktop app" in chat and the agent installs/launches it; a missing exe installs as a **background job** (pollable via the standard job_output/job_list tools, auto-launches when done) while an existing exe launches instantly in the foreground
- A failed install never blocks DSH startup; errors are logged and retried on next activation or tool call

> **First launch of the exe shows the Windows SmartScreen warning** ("Windows protected your PC") because the exe is unsigned — click **More info → Run anyway**; it will not appear again.

## Install

```sh
dsh plugin --profile web add dsh-desktop-plugin
```

Restart DSH (`dsh web`) to activate. Requires Windows + Node ^22.19 or ≥ 24.

## Configuration

See the table above; all keys are optional with those defaults.
