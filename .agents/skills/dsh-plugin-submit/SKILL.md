---
name: dsh-plugin-submit
description: 把一个 DSH 插件完整发布到生态:npm 发包、打 GitHub topic 标签、向 awesome-dsh-plugin 官方注册表提 PR 收录、验证插件市场一键安装。当用户提到"发布 DSH 插件"、"提交插件市场"、"收录到 awesome-dsh-plugin"、"插件上 npm"、"打 dsh-plugin 标签"、"新插件要上架"等时触发,即使没说"技能"也要用。包含已踩坑的完整流程:fork 同步纪律、npm repository 字段校验、pnpm git 源安装需提交构建产物、GitHub 大文件下载要走 curl 等。
---

# DSH 插件提交技能

把一个已开发完成的 DSH 插件发布到生态,让其他人能从插件市场(dsh-market)一键安装。整条链共 5 个交付物:

```
插件包(npm) → GitHub topic → 注册表 PR →(官方探测自动挂 npm 映射)→ 市场一键安装
```

## 前置检查(缺一不可)

- [ ] 插件能构建(`pnpm build`)且测试全绿
- [ ] `package.json` 含 **`repository` 字段并指向插件所在的 GitHub 仓库**——注册表探测用它做防抢注校验,缺了 npm 映射永远挂不上(monorepo 子目录加 `"directory": "子目录路径"`)
- [ ] 构建产物 `lib/` **已提交进仓库**——pnpm 从 GitHub 源安装不会执行构建,缺 lib 会直接导致用户 DSH 启动崩溃
- [ ] 插件形态符合官方模板:ESM + `name/inject/Config/apply` 导出 + `package.json` 声明 `dsh.bundle.patch` → `cordis.patch.yml`

## 第 1 步:发 npm

```sh
cd <插件目录>
npm whoami                    # 未登录需用户操作(浏览器授权)
npm publish --access public
```

- **令牌**:npm 强制发布要 2FA。让用户在 npmjs.com 生成 **Classic Token → Automation 类型**(绕过 2FA)发来,用法:
  ```sh
  npm config set "//registry.npmjs.org/:_authToken" "<令牌>"
  npm publish --access public
  npm config delete "//registry.npmjs.org/:_authToken"   # 立即清除,不落盘
  ```
  注意:`NODE_AUTH_TOKEN` 环境变量对 npm 无效,必须走 .npmrc。用完提醒用户撤销令牌。
- **版本号约定**(用户的项目):插件若配套桌面应用,**共用同一条版本线**(插件 1.4.2 = 应用 v1.4.2);插件单独改进时版本号继续前进。
- 发完验证:`npm view <包名> version repository.url`——**必须能看到 repository 字段**,等 CDN 传播约 30-60 秒。

## 第 2 步:打 GitHub topic

```sh
gh repo edit --add-topic dsh-plugin --add-topic dsh --add-topic deepseek-harness
# 再按插件类型补领域标签,如: ui / tools / notify / typescript / tauri
```

`dsh-plugin` 是注册表 CI 的发现入口,生态铁三角是 `dsh-plugin + dsh + deepseek-harness`(官方仓库、注册表本身、官方模板全都这么组合)。

## 第 3 步:向 awesome-dsh-plugin 提收录 PR

**关键纪律:先用分身(fork)提交,且每次提交前必须同步分身。**

1. 没有分身就建:`gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false`,然后 clone 到临时目录
2. **同步分身**:`git fetch origin && git reset --hard origin/main`——丢弃分身上所有未被子游采纳的旧提交,否则会污染新 PR
3. 开新分支,在 **README.md 和 README.zh.md 两个文件**的对应分类下各加一行:

   ```markdown
   - [owner/插件名](https://github.com/owner/repo/tree/main/插件目录) - 一句话英文描述。      (英文 README,用 " - ")
   - [owner/插件名](https://github.com/owner/repo/tree/main/插件目录) — 一句话中文描述。      (中文 README,用 "—")
   ```

   分类从这些里选:UI Enhancements(ui) / Themes / Sessions / Memory / Tools & Capabilities / Skills / Workflow / Notifications / Models / Development / Fun
4. 提交推送分身,然后开 PR:
   ```sh
   gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
     --title "Add <插件名> (<分类>)" \
     --body "一行双语条目 + 安装命令 + 已打 dsh-plugin topic 的说明"
   ```
5. **绝对不要手改 `data/npm-map.json`**——那是官方探测管道的生成文件,手改会被覆盖并被关闭 PR(实测教训)。npm 映射由探测在验证 `repository` 字段后自动挂上。

## 第 4 步:验证闭环

```sh
npm view <包名> version                                        # npm 最新版
curl -s https://awesome-dsh-plugin.com/plugins.json           # 注册表数据(找插件条目看 npm 字段)
```

- PR 合并 → 条目上线 awesome-dsh-plugin.com;npm 映射在**下一次探测运行**后才从 null 变成包名(通常隔夜)——这是正常的,不要催
- 最终验证(模拟市场按钮动作):`dsh plugin --profile web remove <包名> && dsh plugin --profile web add <包名>` → 重启 DSH 确认激活

## 已知坑(踩过的,别再踩)

| 坑 | 解法 |
|---|---|
| Node fetch 下载 GitHub 大文件(数 MB)挂死 | 二进制下载用系统 `curl.exe`(spawn,加 `--retry 2 --max-time 150`);小 JSON 用 fetch 没问题 |
| pnpm 从 GitHub 源装插件缺 `lib/` 崩溃 | 构建产物提交进仓库(plugin/.gitignore 只忽略 node_modules) |
| 中文文件名经 bash→cmd/powershell 传参乱码 | 用纯 ASCII 路径操作,或按内容特征(grep)选中文件;用户双击不受影响 |
| npm 发包 403 要 2FA | Classic Token → Automation 类型(见第 1 步) |
| 市场(dshmarket)只认 npm 包名或裸 GitHub 仓库 URL | 插件必须发 npm 才能被市场按钮安装;monorepo 子目录条目靠探测自动映射 npm |
| 公司终端安全策略静默删除"隐藏启动 cmd+重定向"类 .cmd 脚本 | 脚本用 `start /min`(可见最小化窗口)而非 `-WindowStyle Hidden` |
| git push 频繁 Connection reset | 重试循环 + `git -c http.proxy= -c https.proxy= push`(代理绕过) |

## 版本与发布节奏(2026-08-16 起)

- **插件 npm 包按需且限频发布**:仅当插件本身有功能变更时才发 npm,且**至多隔一天发一次**(变更攒批发布),非常紧急的修复例外;应用版本自由前进(GitHub Release 即完成发布)
- 桌面端启动时会自动把已装插件对齐 **npm 最新版**(只升不降),所以 npm 落后于应用版本不会造成任何问题
- 历史:1.5.8 之前插件与应用共用版本线逐版对齐,后因发版频繁改为解耦

## 工作方式(接需求时的节奏)

- 用户提新需求时,不要马上进计划模式把自己束缚住,按这个节奏走:
  1. 先**整理需求**——用自己的话复述给用户确认,有歧义当场问清;
  2. 再**完全访问调查**——读代码、查配置、跑验证,把该查的都查完,不受计划模式只读限制;
  3. 直到「准备动手写」才进入计划模式,计划里只写已调查实的做法。
- 一句话:计划模式是写代码前的最后确认,不是调查的起点。

## 持续优化本技能(每次使用后执行)

每次真实使用本技能发布插件后,做一轮复盘并回写:

1. **找差异**:实际过程与技能写法有哪些不同?遇到「已知坑」没覆盖的新问题?官方规则变了(注册表条目格式/分类/探测行为/npm 发包政策/市场源格式)?
2. **回写经验**:有新发现就更新本 SKILL.md——新坑加进坑表;官方流程变化修正对应步骤;某个步骤被证明多余或失效就**删掉**(保持精炼,宁可删也不要堆规则)。
3. **同步双副本**:以本地 `~/.agents/skills/dsh-plugin-submit/` 为主副本;改完做脱敏检查(无令牌/无本机路径/无隐私),拷贝到仓库 `.agents/skills/dsh-plugin-submit/`,随下次提交推送。
4. **追加更新记录**(见下),一行一条,写清日期和来源。

### 更新记录

- 2026-08-15: 初版,沉淀自 dsh-desktop-plugin 上架全程实战(npm 三个版本迭代、注册表 PR #212 合并 / #242 被关闭的教训、市场源限制、curl 下载修复)
- 2026-08-14: 新增「工作方式」节——需求先整理+调查完才进计划模式(用户明确要求:不要一上来就开计划模式束缚自己)
- 2026-08-16: 新增「版本与发布节奏」节——稳定期插件 npm 按需发布,不再逐版对齐应用版本(用户指示"稳定了就不要频繁提交npm");同日补充:**至多隔一天发一次 npm**,紧急修复例外
