---
name: obsidian-plugin
description: Guidelines for developing, validating, and submitting Obsidian community plugins. Covers plugin authoring best practices (memory management, type safety, UI/UX, file & vault operations, CSS, accessibility, code quality) and submission & validation (eslint-plugin-obsidianmd rules, community scanner, manifest/naming requirements). Use when working with Obsidian plugins, main.ts, manifest.json, Plugin class, or vault operations. Pair with the obsidian_plugin_scaffold, obsidian_plugin_validate, and obsidian_plugin_version tools.
license: MIT
metadata:
  version: 1.10.1
---

# Obsidian Plugin Development Guidelines

本 skill 提供 Obsidian 社区插件的开发、校验与提交规范：实现功能时遵循下方「插件编写规范」，提交前用 DSH 工具与「校验与提交」表格完成检查。

## DSH Tools

与本 skill 配套的三个确定性工具（参数由 DSH 调用时自行确认）：

| 工具 | 用途 |
|---|---|
| `obsidian_plugin_scaffold` | 基于官方 obsidian-sample-plugin 模板生成合规插件骨架，内置命名/提交规则校验 |
| `obsidian_plugin_validate` | 校验 manifest 必填字段、命名规则、versions.json 映射、package.json 版本一致性，并运行 eslint-plugin-obsidianmd 检查 |
| `obsidian_plugin_version` | 同步 manifest.json / versions.json / package.json 三处版本 |

优先使用这些工具而非手工编辑文件；工具的命名/提交规则与本 skill 的规范一致。

## Workflow

1. **脚手架** — 新建插件时调用 `obsidian_plugin_scaffold`（先确认 id/name/description 符合命名规则）。
2. **实现** — 按「插件编写规范」编写功能代码。
3. **校验** — 调用 `obsidian_plugin_validate` 检查结构与命名并运行 eslint；按返回错误修正后重跑，直到通过。
4. **版本** — 发布时调用 `obsidian_plugin_version` 统一升级版本号。
5. **提交** — 按「校验与提交」表格完成社区扫描与发布准备。

## 插件编写规范

| 规范主题 | 参考文件 | 核心要点 |
|---|---|---|
| 内存与生命周期 | `reference/memory-management.md` | 用 `registerEvent()` / `registerDomEvent()` / `registerInterval()` 自动清理；避免把 view 引用存进插件属性；不手动 `detachLeavesOfType()` |
| 类型安全 | `reference/type-safety.md` | 用 `instanceof` 收窄 TFile/TFolder；DOM 节点用 `.instanceOf(T)`；避免 `any` 与 `var` |
| UI/UX 规范 | `reference/ui-ux.md` | UI 文本用句子大小写；命令名不含 "command"、不重复插件名；1.13+ 用声明式 `getSettingDefinitions()` |
| 文件与 Vault 操作 | `reference/file-operations.md` | 活动文件编辑走 Editor API、后台修改走 `Vault.process()`；删除用 `FileManager.trashFile()`；查找用 `getAbstractFileByPath()` |
| CSS 样式 | `reference/css-styling.md` | 用 Obsidian CSS 变量；选择器作用域到插件容器；避免 `!important` 与 `:has` |
| 无障碍（必做） | `reference/accessibility.md` | 键盘可访问；图标按钮加 ARIA label；`:focus-visible` + 触控目标 ≥ 44×44px |
| 代码质量 | `reference/code-quality.md` | 移除示例代码；用 async/await；用 `createEl()` 等 DOM helpers；替换废弃包 |

## 校验与提交

| 事项 | 参考文件 | 注意事项与修复方式 |
|---|---|---|
| ESLint 配置 | `reference/eslint-setup.md` | 本地 `npx eslint .` 须与社区扫描器一致：使用 `...obsidianmd.configs.recommended`（已内置 typescript-eslint type-checked 规则）；修复 floating promises、require imports 等常见违规 |
| 社区扫描器 | `reference/community-scanner.md` | 扫描器按 release 生成 Scorecard（Health / Review / Disclosures）；`recommended` 即扫描器规则集；目标 90%+，修复所有 warning（warning 公开可见） |
| 提交要求 | `reference/submission.md` | 仓库需 `manifest.json` + `main.js` + `styles.css` + `LICENSE`；语义化版本；GitHub Release tag 匹配 manifest 版本；经 community.obsidian.md 提交 |
