---
name: obsidian-plugin
description: Guidelines for developing, validating, and submitting Obsidian community plugins. Covers plugin authoring best practices (memory management, type safety, UI/UX, file & vault operations, CSS, accessibility, code quality) and submission & validation (eslint-plugin-obsidianmd rules, community scanner, manifest/naming requirements). Use when working with Obsidian plugins, main.ts, manifest.json, Plugin class, or vault operations. Pair with the obsidian_plugin_scaffold, obsidian_plugin_build, obsidian_plugin_deploy, obsidian_plugin_inspect, obsidian_plugin_vault, obsidian_plugin_reload, obsidian_plugin_validate, and obsidian_plugin_version tools.
license: MIT
metadata:
  version: 1.10.1
---

# Obsidian Plugin Development Guidelines

本 skill 提供 Obsidian 社区插件的开发、校验与提交规范：实现功能时遵循下方「插件编写规范」，提交前用 DSH 工具与「校验与提交」表格完成检查。

## DSH Tools

与本 skill 配套的八个确定性工具（参数由 DSH 调用时自行确认）：

| 工具 | 用途 |
|---|---|
| `obsidian_plugin_scaffold` | 基于官方 obsidian-sample-plugin 模板生成合规插件骨架，内置命名/提交规则校验 |
| `obsidian_plugin_build` | 把插件项目打包成可加载的 main.js（CommonJS，obsidian 外部化）并做静态自检；三级降级、绝不启动 watch，并报告实际使用的层级 |
| `obsidian_plugin_deploy` | 把构建产物装进 vault 的 .obsidian/plugins/<id>/ 并更新该库的 community-plugins.json，随后把 vault 记入 dsh.obsidian.json；written / enabled / active 三态分列报告 |
| `obsidian_plugin_inspect` | 只读观测运行中的 App，绝不改动它：status 一次给出体检事实（App 版本、已注册的库、实际应答的库、该库受限模式、目标插件安装/启用/版本匹配、信任弹窗是否待确认），另有 errors / console / dom / css / screenshot / trustCheck |
| `obsidian_plugin_vault` | 管理真机验证用的库：status 报告已注册的库、当前活动窗口与激活将要做什么；ensure 是两步确认（不带 confirm 只描述后果，confirm=true 才登记/打开该库，随后由 App 自证活动库并如实上报信任弹窗）；close（macOS）；prune 尚未实现 |
| `obsidian_plugin_reload` | 让代码改动在运行中的 App 生效：reload / enable / disable / rescan（重扫插件清单索引：Obsidian 只在库加载时扫描一次插件目录）/ unrestrict（显式关闭该库受限模式，会重载窗口）；重载后校验插件是否真的注册进 App 并回报插件日志 |
| `obsidian_plugin_validate` | 校验 manifest 必填字段、命名规则、versions.json 映射、package.json 版本一致性，并运行 eslint-plugin-obsidianmd 检查 |
| `obsidian_plugin_version` | 同步 manifest.json / versions.json / package.json 三处版本 |

优先使用这些工具而非手工编辑文件；工具的命名/提交规则与本 skill 的规范一致。

## Workflow

1. **脚手架** — 新建插件时调用 `obsidian_plugin_scaffold`（先确认 id/name/description 符合命名规则）。
2. **实现** — 按「插件编写规范」编写功能代码。
3. **构建** — 改完代码调用 `obsidian_plugin_build` 打包出 main.js 并跑静态自检；按返回的失败/警告修正后重跑。它只做一次性打包，不会启动 watch 进程。
4. **部署** — 调用 `obsidian_plugin_deploy` 装进测试库（TestVault）并写入启用列表；注意这一步只表示文件已写入、已启用，**不验证运行中的 Obsidian 是否真的加载了插件**（是否加载交给下一步的真机验证）。
5. **真机验证** — 先 `obsidian_plugin_vault action=ensure`（带 `confirm=true` 才会真正登记/打开）把测试库带到前台，再 `obsidian_plugin_reload` 重载并确认插件确实加载，最后用 `obsidian_plugin_inspect` 只读观测（status / errors / console / dom / css / screenshot）。
6. **校验** — 调用 `obsidian_plugin_validate` 检查结构与命名并运行 eslint；按返回错误修正后重跑，直到通过。
7. **版本** — 发布时调用 `obsidian_plugin_version` 统一升级版本号。
8. **提交** — 按「校验与提交」表格完成社区扫描与发布准备。

## 症状 → 动作

| 症状 | 先做什么 | 大概率原因 |
|---|---|---|
| 插件没出现在 Obsidian 里 | `obsidian_plugin_inspect action=status` | 库选错 / 该库处于受限模式 / 未重载 |
| 装了但功能没生效 | `obsidian_plugin_inspect action=trustCheck` | 首次信任未确认，插件不会被加载 |
| 改了代码没变化 | `obsidian_plugin_reload` | 未重载，旧 bundle 还在内存里 |
| 部署成功，但 reload 说找不到插件 | `obsidian_plugin_reload action=rescan` | Obsidian 只在库加载时扫描一次插件目录，刚部署的插件不在清单里 |
| 插件完全不加载 | 显式 `obsidian_plugin_reload action=unrestrict` | 该库处于受限模式；受限模式是逐库设置，只影响该库 |
| 读数像是来自别的库 | 先 `obsidian_plugin_vault action=ensure`，再核对 `obsidian_plugin_inspect action=status` 报告的「实际应答库」 | 窗口级命令跟随当前活动窗口，`vault=` 并不可靠 |
| `Command "x" not found` / `Plugin "x" not found` | 先把目标库带到前台（`obsidian_plugin_vault action=ensure confirm=true`） | 插件类命令按活动窗口解析 |
| 刚读过 console 后 reload 卡住 | 先 detach 调试器（`inspect action=console` 不要留 `keepDebugger`） | 调试器附加与 `plugin:reload` 互斥 |
| UI 与预期不符 | `obsidian_plugin_inspect action=dom / css / screenshot` | 选择器作用域、CSS 变量、无障碍 |
| `require('obsidian')` 报错 | 检查构建是否把 obsidian 外部化 | obsidian 被打进了 bundle |

## 真机调试与观测

工具覆盖不到的 CLI 用法、以及实测出来的环境隐知识，见 `reference/obsidian-cli.md`——它是逃生舱，不是命令目录（完整清单以 `obsidian help` 与官方文档为准）。

| 用途 | 参考文件 | 核心要点 |
|---|---|---|
| CLI 行为与逃生舱 | `reference/obsidian-cli.md` | 三条铁律：需要 App 运行、退出码不可信（按输出判定）、**每次调用都要包超时**；`plugin:*` / `dev:*` / `eval` 按**活动窗口**解析；空输出＝挂死 |
| 观测与排障配方 | `reference/debugging-playbook.md` | 可直接给 `action=eval` 用的片段：插件是否加载、注册了什么、`loadManifests()` 重扫、库的切换与识别；**任何读数都要在同一次调用里带上 `app.vault.getName()`** |

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
