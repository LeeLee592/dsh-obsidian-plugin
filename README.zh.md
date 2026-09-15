# dsh-obsidian-plugin

[🌐 English](./README.md) | **🇨🇳 中文**

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/leelee592/dsh-obsidian-plugin)
[![dshfind](https://dshfind.com/api/badge/LeeLee592/dsh-obsidian-plugin?lang=zh)](https://dshfind.com/zh/plugins/LeeLee592/dsh-obsidian-plugin?ref=badge)

给 DeepSeek Harness（DSH）智能体提供 Obsidian 插件开发能力：脚手架、校验、版本同步，并配套开发规范 skill。

## 主要功能

### skill

- **`obsidian-plugin`**（知识库，源自 [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)）：提供 Obsidian 插件开发的规范指导（插件编写规范、校验与提交），引导 agent 何时、如何开发插件。

### tools

- **`obsidian_plugin_scaffold`**：使用官方 [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) 模板生成合规插件骨架，内置命名/提交规则校验。
- **`obsidian_plugin_validate`**：校验 manifest 必填字段、命名规则、`versions.json` 映射与 `package.json` 版本一致性，并使用官方 [obsidianmd/eslint-plugin](https://github.com/obsidianmd/eslint-plugin)（eslint-plugin-obsidianmd）检查代码。
- **`obsidian_plugin_version`**：同步 `manifest.json` / `versions.json` / `package.json` 三处版本。

## 安装

```bash
dsh plugin --profile web add @leelee592/dsh-obsidian-plugin
```

## 使用

对 DSH 说「帮我新建一个 Obsidian 插件…」，agent 会加载 `obsidian-plugin` skill，按照 *Obsidian Plugin Development Guidelines* 的指导进行插件开发，并在过程中调用 `obsidian_plugin_scaffold` / `obsidian_plugin_validate` / `obsidian_plugin_version` 完成脚手架、校验与版本管理。

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
