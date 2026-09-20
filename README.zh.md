# dsh-obsidian-plugin

[🌐 English](./README.md) | **🇨🇳 中文**

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/leelee592/dsh-obsidian-plugin)
[![dshfind](https://dshfind.com/api/badge/LeeLee592/dsh-obsidian-plugin?lang=zh)](https://dshfind.com/zh/plugins/LeeLee592/dsh-obsidian-plugin?ref=badge)

给 DeepSeek Harness（DSH）智能体提供 Obsidian 插件开发能力：脚手架、构建、离线冒烟、部署、沙箱化端到端测试、真机观察与验证（只读观测，外加一个需审批才能在 App 里执行代码的逃生舱）、校验、版本同步，并配套开发规范 skill。

## 主要功能

### skill

- **`obsidian-plugin`**（知识库，源自 [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)）：提供 Obsidian 插件开发的规范指导（插件编写规范、校验与提交），引导 agent 何时、如何开发插件。

### tools

- **`obsidian_plugin_scaffold`**：使用官方 [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) 模板生成合规插件骨架，内置命名/提交规则校验。
- **`obsidian_plugin_build`**：把插件项目打包成可加载的 `main.js`（CommonJS，`obsidian` 外部化）并做静态自检（L1 档）；入口按「显式 `entry` → `src/main.ts` → 仓库根 `main.ts` → 项目自身的 esbuild/rollup/vite 配置 → `package.json` main」解析，产物按「项目根 → 配置里的 `outfile`/`outdir`/`file`/`dir` → 项目内测试库布局 → 有界搜索（含 `<dir>/.obsidian/plugins/<id>/`）」解析，失败时列出全部尝试过的位置，另可用 `outDir` 直接指定产物目录；构建三级降级（项目自身的 production `build` 脚本——**只要存在打包配置就优先走它**，因为配置里带的插件无法从命令行补齐 → 项目本地 esbuild 直调，用于没有配置可遵循的项目，或作为显式的非 production 选择（会警告未应用项目插件）→ 给出可操作的报错），不启动 watch 进程，并报告实际使用的层级。
- **`obsidian_plugin_deploy`**：把构建产物安装进 `<vault>/.obsidian/plugins/<id>/`，并把插件 id 合并进该库的 `community-plugins.json`（保留既有条目），随后把该 vault 记入 `dsh.obsidian.json`；分列报告 `written` / `enabled` / `active` 三态（`active` 在后续阶段前恒为 `unknown`）。
- **`obsidian_plugin_inspect`**：只读观测运行中的 App —— `status` 一次给出体检事实（App 实际版本、已注册的库、**实际应答的库**、该库的受限模式状态、目标插件是否已安装/启用/版本匹配、Obsidian 的信任弹窗是否待确认），另有 `errors` / `console` / `dom` / `css` / `screenshot` / `trustCheck`；绝不改动 App。
- **`obsidian_plugin_vault`**：管理真机验证用的库 —— `status`（已注册的库、当前活动窗口、激活将要做什么）、`ensure`（不带 `confirm` 只描述后果；带 `confirm=true` 才会登记/打开该库，Obsidian 会切到前台，随后由 App 自证哪个库是活动库，并如实上报 Obsidian 的信任弹窗而不代为确认）、`close`（macOS）、`prune`（尚未实现）。
- **`obsidian_plugin_reload`**：让代码改动在运行中的 App 生效 —— `reload`（默认）/ `enable` / `disable` / `rescan`（刷新 App 的插件清单索引：Obsidian 只在库加载时扫描一次插件目录，刚部署的插件在重扫前对所有插件命令都不可见）/ `unrestrict`（**关闭**该库的受限模式——逐库的安全设置、会重载窗口，因此必须是显式动作，绝不作为副作用）；重载后校验插件是否真的注册进 App，并回报插件打印的内容。
- **`obsidian_plugin_test`**：离线冒烟（L2 档）——在纯 Node 里用桩化的 Obsidian API 加载构建产物，真跑一遍生命周期（默认导出是 `Plugin` 子类、`onload()` 执行、注册动作发生、`onunload()` 清理、无未处理的 rejection），因此**不需要安装 Obsidian**；会真实解析项目自身的 `@codemirror/*` 与 `@lezer/*`，DOM 相关插件可用项目自带的 jsdom（缺 jsdom 时报告会写明并给出安装命令）；可用可选场景文件（`dsh/scenarios/<name>.mjs`，收到 `{ plugin, app, stub }`）扩展。它**不验证运行期行为**：报告固定标注这是桩环境，点名本次没有覆盖什么（例如没有 DOM 宿主时，注册为编辑器扩展的 UI 代码未被检验），并指向 e2e / screenshot 做真实验收。
- **`obsidian_plugin_e2e`**：脚手架化沙箱端到端测试（L4 档）——WebdriverIO + `wdio-obsidian-service` 会启动一个**独立的 Obsidian**（独立配置目录 + 库副本），不切你的窗口、不抢焦点；`init` 写入 WebdriverIO 配置（`wdio.conf.mts`、`tsconfig.e2e.json` 与起始 spec——脚手架目录由 `dir` 指定，默认 `e2e/`），加入 `e2e` / `e2e:watch` 脚本并把下载产物目录追加进 `.gitignore`（幂等，手改过的文件在 `force=true` 前保留），`status` 只报告现状与确切的安装命令、不写任何文件；runner 依赖留在你的项目里。
- **`obsidian_plugin_eval`**：在运行中的 Obsidian 里执行 JavaScript 并返回结果——实时状态的逃生舱：读 App 真正持有的东西（插件实例、workspace、`metadataCache`）、驱动一次交互，或不做重新构建就试一个修法。它是**唯一的高特权工具**（在你的 App 里执行代码）：需用户审批，返回会把实际执行的代码回显出来作为审计，代码触及窗口焦点时（如 `electron.remote.getCurrentWindow().focus()`）会明确警告，因为那会抢走你的焦点；`vault` 用于指定目标库，`timeoutMs`（默认 30000）用于长表达式。凡是只读动作能回答的，优先用 `obsidian_plugin_inspect`（免费、无需审批）。
- **`obsidian_plugin_validate`**：校验 manifest 必填字段、命名规则、`versions.json` 映射与 `package.json` 版本一致性，并使用官方 [obsidianmd/eslint-plugin](https://github.com/obsidianmd/eslint-plugin)（eslint-plugin-obsidianmd）检查代码。
- **`obsidian_plugin_version`**：同步 `manifest.json` / `versions.json` / `package.json` 三处版本。

### verification

验证共四档，日常开发循环默认走 L1 + L2 + L4。

| 档 | 含义 | 干扰 |
| --- | --- | --- |
| **L1** 静态 | `obsidian_plugin_build` 内的产物 / 模块格式 / manifest 检查 | 无 |
| **L2** 离线冒烟 | `obsidian_plugin_test` 在纯 Node 里用桩化的 Obsidian API 加载产物；无需 Obsidian | 无 |
| **L3** 用户的 Obsidian | `obsidian_plugin_vault` / `obsidian_plugin_reload` / `obsidian_plugin_inspect` / `obsidian_plugin_eval` 经 CLI 作用于**你自己的**运行中 App，仅用于验证你的真实环境 | 会切换你的窗口、抢焦点 |
| **L4** 沙箱 Obsidian | `obsidian_plugin_e2e` + 项目自建的 WebdriverIO 套件运行一个独立 Obsidian（独立配置、库副本） | 无——开发循环的默认档 |

**检查通过不等于验收。** `obsidian_plugin_build` 通过不代表插件可用，`obsidian_plugin_test` 的 PASS 也不代表 UI 已验证。只要改动涉及界面、渲染或交互，就必须在沙箱档（`obsidian_plugin_e2e`）或对着运行中的 App（`obsidian_plugin_inspect action=screenshot`）**真正看到它**，并在回复里说明看到了什么。

只允许修改**会话工作区内创建的测试库**；你自己的库是只读的，包括 CLI 侧的间接写入——`plugin:enable` / `unrestrict` 改写的是当前活动窗口那个库，工具会拒绝对非测试库执行。默认路径绝不切换你的窗口、绝不抢焦点。

## 安装

```bash
dsh plugin --profile web add @leelee592/dsh-obsidian-plugin
```

## 使用

对 DSH 说「帮我新建一个 Obsidian 插件…」，agent 会加载 `obsidian-plugin` skill，按照 *Obsidian Plugin Development Guidelines* 的指导进行插件开发，并在过程中调用 `obsidian_plugin_scaffold` / `obsidian_plugin_build` / `obsidian_plugin_test` / `obsidian_plugin_deploy` / `obsidian_plugin_e2e` / `obsidian_plugin_inspect` / `obsidian_plugin_vault` / `obsidian_plugin_reload` / `obsidian_plugin_eval` / `obsidian_plugin_validate` / `obsidian_plugin_version` 完成脚手架、构建、离线冒烟、部署、沙箱化端到端测试、真机观察与验证、在 App 里执行代码、校验与版本管理。

## 文档

- [doc/harness.default.md](doc/harness.default.md) —— 插件的 HARNESS 会话上下文（定位 / 能力 / 使用规则）。
- [doc/version-notes.json](doc/version-notes.json) —— 历史版本更新说明（最新在上，中英双语）。
- [doc/manual.zh.txt](doc/manual.zh.txt) / [doc/manual.en.txt](doc/manual.en.txt) —— 使用手册。

## 兼容性

| 项 | 值 |
| --- | --- |
| profile | `web` |
| DeepSeek Harness | 0.1.5-rc 实测 |
| peer deps | `@deepseek-ai/cordis` ^4.0.2 · `@deepseek-ai/dsh-tools` ^0.1.5-rc.2 · `@deepseek-ai/schemastery` ^3.18.2 |
| 权限 | 注入 `tools` + `fs`（受 DSH 沙箱约束，无外部网络调用） |
| Node（开发构建） | 20+ |
| License | MIT |
