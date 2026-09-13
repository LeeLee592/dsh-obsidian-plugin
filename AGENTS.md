# AGENTS.md

本文件面向在该仓库工作的 AI 编码代理（agent），描述项目核心能力、架构、常用命令与必须遵守的约定。

## Project overview

- 目标：一个 DeepSeek Harness（DSH）插件，为 DSH 智能体提供 **Obsidian 插件开发能力**——脚手架、校验、版本同步，并配套开发规范 skill。
- 形态：一个 DSH bundle（cordis 插件）`@leelee/dsh-obsidian-plugin` + 内置 `obsidian-plugin` skill。
- 入口：`src/index.ts` 编译为 `lib/index.js`，由 DSH loader 加载并注册 3 个工具。
- 工具：`obsidian_plugin_scaffold`（复用 obsidian-sample-plugin 模板）、`obsidian_plugin_validate`（结构校验 + eslint-plugin-obsidianmd 检查）、`obsidian_plugin_version`（三处版本同步）。

## 架构

两个互补、职责单一的部分（详见 `DEVELOP.md`）：

1. **知识（skill）** —— `obsidian-plugin` skill，内置于 `.agents/skills/obsidian-plugin`，由 DSH 的 project-agents root（rank 200）自动发现。
2. **护栏（tool bundle）** —— 本仓库 cordis 插件，用 typed schema 暴露 3 个工具，把确定性操作封装起来；命名/提交规则同时固化在代码护栏与 skill 文档中。

## Environment & tooling

- Node.js 20+。
- 包管理器：**pnpm**（`package.json` 声明 `packageManager`）。
- 构建：`tsc` → `lib/`。
- 类型：`@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`（peer deps，由 DSH 运行时解析）。

## 常用命令

```bash
pnpm install            # 安装依赖（typescript + @types/node + peer 类型）
pnpm run link-dsh-deps  # 链接 $DSH_HOME 的 @deepseek-ai 类型（可选）
pnpm run typecheck      # tsc --noEmit 类型检查
pnpm run build          # tsc -> lib/
pnpm run deploy         # build + 注册进 profile + dump-config 验证
```

## 目录结构

```
.
├── package.json          # dsh.bundle manifest + scripts + peerDeps
├── cordis.patch.yml      # insert obsidian-plugin -> @leelee/dsh-obsidian-plugin
├── tsconfig.json         # tsc -> lib/
├── src/
│   ├── index.ts          # 工具插件（3 个工具的实现）
│   └── bundle-doc.ts     # 读取包内 doc/ 资源
├── scripts/
│   ├── link-dsh-deps.mjs # 链接 DSH 类型
│   └── deploy.sh         # build + 注册工具 + 验证
├── assets/
│   └── templates/        # obsidian-sample-plugin 模板（14 个文件，含占位符）
├── .agents/
│   └── skills/obsidian-plugin/  # 内置 skill（SKILL.md + reference/）
├── doc/                  # HARNESS 上下文 + 使用手册 + 版本说明
├── lib/                  # 构建产物（gitignore）
└── README.md / DEVELOP.md（中英双语）
```

## 约定（必须遵守）

### 文档同步（架构变更时）

每次架构 / 接口 / 命名变更（新增、删除、重命名工具；skill 结构或决策表调整；模板 / 目录 / 依赖变化等），必须**按需检查并同步**以下文件中的相关描述：

- `README.md` / `README.en.md`
- `DEVELOP.md` / `DEVELOP.en.md`
- `doc/harness.default.md`
- `doc/manual.zh.txt` / `doc/manual.en.txt`
- `doc/version-notes.json`
- `.agents/skills/obsidian-plugin/SKILL.md`

中英文版本必须同步更新，保持内容一一对应。

### 可沉淀规则

工具实现过程中总结出的通用规则（如路径解析、沙箱策略、模板外置等），必须沉淀到 `DEVELOP.md` 的「## 工具实现要点」中，并同步到 `DEVELOP.en.md`。

### 其他约定

- 工具名统一使用 `obsidian_plugin_` 前缀。
- 不在工具代码里内嵌大量模板字符串；模板外置到 `assets/templates/`，运行时用 `new URL('../assets/templates/<file>', import.meta.url)` 读取 + 占位符替换。
- 文件读写走 `ctx.fs`（受沙箱约束）；相对路径用 `ctx.fs.resolve(path, { cwd: workspaceRoot })` 解析（不用 `process.cwd()`）；写操作传会话 `sandboxPolicy`（用 `ctx.get("sandboxPolicy")`，不用属性访问）。
- 命名/提交规则护栏：id 不含 `obsidian`、不以 `plugin` 结尾；name 不含 `Obsidian`、不以 `Plugin` 结尾；description 句末标点、≤250 字符。
- 外部命令（如 eslint）用 `spawnSync` 借用被检项目自身的 `node_modules/.bin`，缺失时降级为 warning。

## Agent do / don't

**Do**

- 架构或命名变更后，同步更新上述中英文文档。
- 通用规则沉淀到 `DEVELOP.md` 的「工具实现要点」。
- 使用 pnpm 而非 npm。
- 工具改名时，同步更新 `SKILL.md` 决策表与 tool reference 中的工具名。

**Don't**

- 在工具代码里内嵌大量模板字符串。
- 用 `process.cwd()` 解析相对路径。
- 用属性访问 `ctx.sandboxPolicy`（会触发 inject 检查报错）。
- 在 README 安装部分添加开发命令（只需 registry 安装命令）。
- 修改工具名 / skill 结构后不更新文档。
