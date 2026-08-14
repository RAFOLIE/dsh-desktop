# dsh-desktop-plugin

DSH 插件:安装并启动 [dsh-desktop-windowos](https://github.com/RAFOLIE/dsh-desktop-windowos) 桌面壳(DeepSeek Harness 的 Windows 托盘应用)。

- 插件激活时自动确保桌面应用就绪:缺失则从 GitHub Releases 下载 exe 到 `%LOCALAPPDATA%\Programs\dsh-desktop-windowos\`,并在桌面创建/刷新**不带版本号**的快捷方式「DeepSeek Harness」;已存在则跳过下载
- 注册 `desktop_launch` 工具:对话里说"打开桌面应用"即可安装并拉起, agent 可直接调用
- 安装/下载失败不影响 DSH 启动,错误只记录日志,下次激活或调用工具时重试

## 安装

```sh
dsh plugin --profile web add github:RAFOLIE/dsh-desktop-windowos#path:/plugin
```

重启 DSH(`dsh web`)后生效。要求 Windows + Node ^22.19 或 ≥ 24。

## 配置(cordis.patch.yml)

| 字段 | 默认 | 说明 |
|---|---|---|
| autoInstall | true | 激活时自动安装/刷新 |
| createShortcut | true | 创建桌面快捷方式 |
| installDir | %LOCALAPPDATA%\Programs\dsh-desktop-windowos | exe 安装目录 |
| shortcutName | DeepSeek Harness | 快捷方式名称(无版本号) |
| repoSlug | RAFOLIE/dsh-desktop-windowos | exe 的 GitHub Release 来源 |

# English

DSH plugin that installs and launches [dsh-desktop-windowos](https://github.com/RAFOLIE/dsh-desktop-windowos) — the Windows tray shell for DeepSeek Harness.

- On activation it ensures the desktop app is ready: downloads the exe from GitHub Releases into `%LOCALAPPDATA%\Programs\dsh-desktop-windowos` when missing and creates/refreshes a version-less desktop shortcut "DeepSeek Harness"; existing installs are left alone
- Registers the `desktop_launch` tool — say "open the desktop app" in chat and the agent installs/launches it
- A failed install never blocks DSH startup; errors are logged and retried on next activation or tool call

## Install

```sh
dsh plugin --profile web add github:RAFOLIE/dsh-desktop-windowos#path:/plugin
```

Restart DSH (`dsh web`) to activate. Requires Windows + Node ^22.19 or ≥ 24.

## Configuration

See the table above; all keys are optional with those defaults.
