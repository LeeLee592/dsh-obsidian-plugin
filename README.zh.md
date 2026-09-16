# dsh-obsidian-plugin

[🌐 English](./README.md) | **🇨🇳 中文**

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/leelee592/dsh-obsidian-plugin)
[![dshfind](https://dshfind.com/api/badge/LeeLee592/dsh-obsidian-plugin?lang=zh)](https://dshfind.com/zh/plugins/LeeLee592/dsh-obsidian-plugin?ref=badge)

给 DeepSeek Harness（DSH）智能体提供 Obsidian 插件开发能力：脚手架、构建、部署、真机观察与验证、校验、版本同步，并配套开发规范 skill。

## 主要功能

### skill

- **`obsidian-plugin`**（知识库，源自 [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)）：提供 Obsidian 插件开发的规范指导（插件编写规范、校验与提交），引导 agent 何时、如何开发插件。

### tools

- **`obsidian_plugin_scaffold`**：使用官方 [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) 模板生成合规插件骨架，内置命名/提交规则校验。
- **`obsidian_plugin_build`**：把插件项目打包成可加载的 `main.js`（CommonJS，`obsidian` 外部化）并做静态自检；构建三级降级（项目本地 esbuild → 项目自身的 production `build` 脚本 → 给出可操作的报错），不启动 watch 进程，并报告实际使用的层级。
- **`obsidian_plugin_deploy`**：把构建产物安装进 `<vault>/.obsidian/plugins/<id>/`，并把插件 id 合并进该库的 `community-plugins.json`（保留既有条目），随后把该 vault 记入 `dsh.obsidian.json`；分列报告 `written` / `enabled` / `active` 三态（`active` 在后续阶段前恒为 `unknown`）。
- **`obsidian_plugin_inspect`**：只读观测运行中的 App —— `status` 一次给出体检事实（App 实际版本、已注册的库、**实际应答的库**、该库的受限模式状态、目标插件是否已安装/启用/版本匹配、Obsidian 的信任弹窗是否待确认），另有 `errors` / `console` / `dom` / `css` / `screenshot` / `trustCheck`；绝不改动 App。
- **`obsidian_plugin_vault`**：管理真机验证用的库 —— `status`（已注册的库、当前活动窗口、激活将要做什么）、`ensure`（不带 `confirm` 只描述后果；带 `confirm=true` 才会登记/打开该库，Obsidian 会切到前台，随后由 App 自证哪个库是活动库，并如实上报 Obsidian 的信任弹窗而不代为确认）、`close`（macOS）、`prune`（尚未实现）。
- **`obsidian_plugin_reload`**：让代码改动在运行中的 App 生效 —— `reload`（默认）/ `enable` / `disable` / `rescan`（刷新 App 的插件清单索引：Obsidian 只在库加载时扫描一次插件目录，刚部署的插件在重扫前对所有插件命令都不可见）/ `unrestrict`（**关闭**该库的受限模式——逐库的安全设置、会重载窗口，因此必须是显式动作，绝不作为副作用）；重载后校验插件是否真的注册进 App，并回报插件打印的内容。
- **`obsidian_plugin_validate`**：校验 manifest 必填字段、命名规则、`versions.json` 映射与 `package.json` 版本一致性，并使用官方 [obsidianmd/eslint-plugin](https://github.com/obsidianmd/eslint-plugin)（eslint-plugin-obsidianmd）检查代码。
- **`obsidian_plugin_version`**：同步 `manifest.json` / `versions.json` / `package.json` 三处版本。

## 安装

```bash
dsh plugin --profile web add @leelee592/dsh-obsidian-plugin
```

## 使用

对 DSH 说「帮我新建一个 Obsidian 插件…」，agent 会加载 `obsidian-plugin` skill，按照 *Obsidian Plugin Development Guidelines* 的指导进行插件开发，并在过程中调用 `obsidian_plugin_scaffold` / `obsidian_plugin_build` / `obsidian_plugin_deploy` / `obsidian_plugin_inspect` / `obsidian_plugin_vault` / `obsidian_plugin_reload` / `obsidian_plugin_validate` / `obsidian_plugin_version` 完成脚手架、构建、部署、真机观察与验证、校验与版本管理。

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
