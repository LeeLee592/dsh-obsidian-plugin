# AGENTS.md

本文件面向在该仓库工作的 AI 编码代理（agent）。项目详情以各文档为准，这里只列必须遵守的约定。

## 文档索引

- 核心能力、主要功能、安装与使用：见 `README.md`（中文）/ `README.en.md`（英文）。
- 架构设计、目录结构、开发测试命令：见 `DEVELOP.md`（中文）/ `DEVELOP.en.md`（英文）。
- 开发规范知识（插件编写规范、校验与提交）：见 `.agents/skills/obsidian-plugin/SKILL.md`。

## 约定（必须遵守）

### 文档同步（架构变更时）

每次架构 / 接口 / 命名变更（新增、删除、重命名工具；skill 结构或决策表调整；模板 / 目录 / 依赖变化等），必须**按需检查并同步**以下文件中的相关描述，中英文同步：

- `README.md` / `README.en.md`
- `DEVELOP.md` / `DEVELOP.en.md`
- `doc/harness.default.md`
- `doc/manual.zh.txt` / `doc/manual.en.txt`
- `doc/version-notes.json`
- `.agents/skills/obsidian-plugin/SKILL.md`

### 可沉淀规则

工具实现过程中总结出的通用规则（如路径解析、沙箱策略、模板外置等），必须沉淀到 `DEVELOP.md` 的「## 工具实现要点」中，并同步到 `DEVELOP.en.md`。

### 代码开发

- 遵循 `DEVELOP.md` 的「## 工具实现要点」中的通用规则。
- 遵循 DeepSeek Harness 插件的 Cordis 开发规范：插件导出 `name` / `inject` / `apply(ctx, config)`；用 `ctx.tools.register(defineTool({...}))` 注册工具；服务用 `ctx.get(...)` 获取（不属性访问）；文件读写走 `ctx.fs`（受沙箱约束）。
