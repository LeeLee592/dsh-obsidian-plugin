# 开发文档

🇨🇳 **中文** | [🌐 English](./DEVELOP.en.md)

## 目标

让 DeepSeek Harness（DSH）的智能体可靠地完成 Obsidian 插件的脚手架、校验与版本同步，并配套提供开发规范知识（skill）。

## 架构

两个互补、职责单一的部分：

1. **知识（skill）**——Obsidian 插件开发规范（命名/提交规则、无障碍、代码质量、提交与 Scorecard）。源自 [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)，内置为 [assets/skills/obsidian-plugin](assets/skills/obsidian-plugin/SKILL.md)，并在 `apply()` 里通过 `ctx.skills.register` 注册为 runtime skill（不依赖 project root）。
2. **护栏（tool bundle）**——本仓库 `@leelee/dsh-obsidian-plugin`，用 typed schema 暴露 3 个工具，把确定性操作封装起来：
   - `obsidian_plugin_scaffold` —— 复用 obsidian-sample-plugin 模板生成骨架
   - `obsidian_plugin_validate` —— 结构校验 + eslint-plugin-obsidianmd 检查
   - `obsidian_plugin_version` —— 三处版本同步

```
┌────────────────────────────────────────────┐
│ DSH Host（内置 tools / fs / skill / bash） │
└───────▲──────────────────────────▲─────────┘
        │ 工具(bundle)             │ skill 发现
┌───────┴──────────────────────┐  ┌────────┴───────────────────┐
│ @leelee/dsh-obsidian-plugin │  │ obsidian-plugin skill（内置）  │
│  scaffold/validate/version  │  │  SKILL.md + reference/*     │
└─────────────────────────────┘  └─────────────────────────────┘
```

## 目录结构

```
.
├── package.json          # dsh.bundle manifest + scripts + peerDeps
├── cordis.patch.yml      # insert obsidian-plugin -> @leelee/dsh-obsidian-plugin
├── tsconfig.json         # tsc -> lib/
├── pnpm-lock.yaml        # pnpm 锁文件
├── src/
│   ├── index.ts          # 工具插件（3 个工具的实现）
│   └── bundle-doc.ts     # 读取包内 doc/ 资源
├── scripts/
│   ├── link-dsh-deps.mjs # 链接 $DSH_HOME 的 @deepseek-ai 类型
│   └── deploy.sh         # build + 注册工具 + dump-config 验证
├── assets/
│   ├── templates/        # obsidian-sample-plugin 模板（14 个文件，含占位符）
│   └── skills/obsidian-plugin/  # 内置 skill（SKILL.md + reference/）
├── doc/                  # HARNESS 上下文 + 使用手册 + 版本说明
├── lib/                  # 构建产物（gitignore）
└── README.md / DEVELOP.md
```

## 开发测试

```bash
pnpm install            # 安装依赖（typescript + @types/node + peer 类型）
pnpm run link-dsh-deps  # 链接 $DSH_HOME/profiles/node_modules/@deepseek-ai 类型
pnpm run typecheck      # tsc --noEmit 类型检查
pnpm run build          # tsc -> lib/
pnpm run deploy         # build + 注册进 profile + dump-config 验证
```

`pnpm run deploy` 等价于：`pnpm run build` → `dsh plugin --profile web add "$(pwd)"` → `dsh --profile web --dump-config` 并校验输出包含 `obsidian-plugin`。默认 profile 为 `web`，可用 `DSH_PROFILE=<name>` 或 `pnpm run deploy -- <name>` 覆盖。

## 工具实现要点

可沉淀的通用规则：

- **路径解析**：相对路径必须通过 `ctx.fs.resolve(path, { cwd: workspaceRoot })` 解析（锚定到会话工作区），不要用 `process.cwd()`。
- **沙箱策略**：每次写操作都要把会话 `sandboxPolicy` 传给 `ctx.fs.writeText(target, content, intent, signal, policy)`；policy 用 `ctx.get("sandboxPolicy")?.resolve({ session })` 获取（`ctx.get` 不触发 inject 检查，不要用属性访问 `ctx.sandboxPolicy`）。
- **模板外置**：不在工具代码里内嵌大量模板字符串；模板作为包内 assets（`assets/templates/`）随包分发，运行时用 `new URL('../assets/templates/<file>', import.meta.url)` 读取 + 占位符替换。
- **进程执行**：需要跑外部命令（如 eslint）时，`spawnSync` 借用被检项目自身的 `node_modules/.bin`，不存在时降级为 warning 而非报错。
- **命名/提交规则护栏**：id 不含 `obsidian`、不以 `plugin` 结尾；name 不含 `Obsidian`、不以 `Plugin` 结尾；description 句末标点、≤250 字符——同时固化在 scaffold/validate 代码护栏与 skill 文档中。
- **文件读写 seam**：`inject: ["tools", "fs"]`，读写走 `ctx.fs`（受沙箱约束），`ctx.fs` 缺省时回退 `node:fs`（bare-Node 测试场景）。
- **skill 分发**：skill 作为插件资产放在 `assets/skills/` 随包分发，并在 `apply()` 里用 `ctx.get("skills")?.register({...})` 注册 runtime skill（body 从包内 `new URL('../assets/skills/<name>/SKILL.md', import.meta.url)` 读取）。
