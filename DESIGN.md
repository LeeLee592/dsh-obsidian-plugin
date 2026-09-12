# 设计文档

## 目标

让 DeepSeek Harness（DSH）的智能体可靠地完成 Obsidian 插件的**脚手架、校验、构建、版本同步与提交发布**（Scope A：DSH 是开发方）。

## 架构

两个互补、职责单一的部分：

1. **知识（skill）**——Obsidian API、命名/提交规则、无障碍、社区提交与 Scorecard 指南。来自 [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)，以 **git submodule** 引入，不复制进仓库；`install-skill.sh` 软链到 DSH 的 skill 发现根。
2. **护栏（tool bundle）**——本仓库 `@dsh-obsidian/tool`，用 typed schema 暴露 3 个工具，把「脚手架、校验、版本同步」这些容易出错的确定性操作封装起来。

```
┌────────────────────────────────────────────┐
│ DSH Host（内置 tools / fs / skill / bash） │
└───────▲──────────────────────────▲─────────┘
        │ 工具(bundle)             │ skill 发现
┌───────┴──────────────┐  ┌────────┴───────────────────┐
│ @dsh-obsidian/tool    │  │ obsidian skill（submodule） │
│  scaffold/validate/   │  │  SKILL.md + reference/*     │
│  version              │  └─────────────────────────────┘
└───────────────────────┘
```

## 目录结构

```
.
├── package.json          # dsh.bundle manifest + scripts + peerDeps
├── cordis.patch.yml      # insert obsidian-dev -> @dsh-obsidian/tool
├── tsconfig.json         # tsc -> lib/
├── src/index.ts          # 工具插件（唯一的实现）
├── scripts/
│   ├── link-dsh-deps.mjs # 链接 $DSH_HOME/profiles/node_modules/@deepseek-ai 类型
│   └── install-skill.sh  # 软链 submodule skill 到发现根
├── third_party/obsidian-plugin-skill/   # git submodule（gapmiss skill）
├── lib/                  # 构建产物（gitignore）
├── DESIGN.md / README.md
```

## 集成点（DSH 0.1.5-rc 实测）

- **bundle manifest**：`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`；patch 用 `insert` 挂载 `id: obsidian-dev, name: '@dsh-obsidian/tool'`。缺失该声明时 loader 报 `declares no dsh.bundle`。
- **安装**：`dsh plugin --profile web add <checkout>`（转发 pnpm，链接本 checkout 并追加进 `dsh.profile.bundles`）。
- **配置覆盖**：`defaultMinAppVersion`（默认 `1.13.0`）可由用户在 profile 的 `cordis.patch.yml` 按 id 覆盖；patch 覆盖整行 `config`（不深合并），故只给「用户大概率保留」的默认值。
- **peer 依赖**：`@deepseek-ai/cordis`/`dsh-tools`/`schemastery` 由 DSH 安装目录解析，不随包分发。
- **skill**：submodule 的 `obsidian` skill 通过软链进入 `.dsh/skills`（rank 100）或 `~/.dsh/skills`（rank 400）被自动发现。

## 工具实现要点

- `inject: ["tools", "fs"]`；文件读写走 `ctx.fs`（受沙箱约束），`ctx.fs` 缺省时回退 `node:fs`（bare-Node 场景）。
- `defineTool` 声明参数 schema 与输出；`execute` 返回文本报告。
- 命名/提交规则（`eslint-plugin-obsidianmd` / `validate-plugin-entry.yml`）内置于 `scaffold`/`validate`：id 不含 `obsidian`、不以 `plugin` 结尾；name 不含 `Obsidian`、不以 `Plugin` 结尾；description 句末标点、≤250 字符。

## 验证（官方文档方式）

1. `dsh --profile web --dump-config` —— 组合层出现 `# == @dsh-obsidian/tool` 与 `id: obsidian-dev`。
2. `dsh web` 后，模型工具集多出 3 个 `obsidian_*` 工具；在会话里让模型调用 `obsidian_scaffold` / `obsidian_validate` / `obsidian_version` 验证行为。

参考：[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish.md) · [开发一个 Tool](https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool.md)
