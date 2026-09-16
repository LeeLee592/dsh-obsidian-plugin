# 开发文档

[🌐 English](./DEVELOP.md) | **🇨🇳 中文**

## 目标

让 DeepSeek Harness（DSH）的智能体可靠地完成 Obsidian 插件的脚手架、构建、部署、校验与版本同步，并配套提供开发规范知识（skill）。

## 架构

两个互补、职责单一的部分：

1. **知识（skill）**——Obsidian 插件开发规范（命名/提交规则、无障碍、代码质量、提交与 Scorecard）。源自 [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)，内置为 [assets/skills/obsidian-plugin](assets/skills/obsidian-plugin/SKILL.md)，并在 `apply()` 里通过 `ctx.skills.register` 注册为 runtime skill（不依赖 project root）。
2. **护栏（tool bundle）**——本仓库 `@leelee592/dsh-obsidian-plugin`，用 typed schema 暴露 5 个工具，把确定性操作封装起来：
   - `obsidian_plugin_scaffold` —— 复用 obsidian-sample-plugin 模板生成骨架
   - `obsidian_plugin_build` —— 把 src/main.ts 打包成可加载的 main.js + 静态自检
   - `obsidian_plugin_deploy` —— 把构建产物装进 vault 并启用插件 id
   - `obsidian_plugin_validate` —— 结构校验 + eslint-plugin-obsidianmd 检查
   - `obsidian_plugin_version` —— 三处版本同步

```
┌────────────────────────────────────────────┐
│ DSH Host（内置 tools / fs / skill / bash） │
└───────▲──────────────────────────▲─────────┘
        │ 工具(bundle)             │ skill 发现
┌───────┴──────────────────────┐  ┌────────┴───────────────────┐
│ @leelee592/dsh-obsidian-plugin │  │ obsidian-plugin skill（内置）  │
│  5 tools, scaffold…version  │  │  SKILL.md + reference/*     │
└─────────────────────────────┘  └─────────────────────────────┘
```

## 目录结构

```
.
├── package.json          # dsh.bundle manifest + scripts + peerDeps
├── cordis.patch.yml      # insert obsidian-plugin -> @leelee592/dsh-obsidian-plugin
├── tsconfig.json         # tsc -> lib/
├── pnpm-lock.yaml        # pnpm 锁文件
├── src/
│   ├── index.ts          # apply()：工具注册、Config、模板与 skill 装配
│   ├── fs.ts             # 文件系统 seam：路径/target 双身份、sandboxPolicy、workspaceRoot
│   ├── proc.ts           # spawnSync 封装：超时 + 结果分类
│   ├── naming.ts         # 提交命名规则、占位符渲染、semver
│   ├── build.ts          # obsidian_plugin_build：三级降级 + 静态自检
│   ├── deploy.ts         # obsidian_plugin_deploy：vault 解析、产物安装、绑定写入
│   └── bundle-doc.ts     # 读取包内 doc/ 资源
├── test/
│   └── p0.test.ts        # node:test 跑在 lib/ 上（裸 Node，无需 harness）
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
- **路径有两种身份，不可混用**：后端返回的 `FsTarget` 是用于读取与受沙箱约束写入的不透明句柄；而「操作系统绝对路径」才是子进程（esbuild、外部 CLI）能打开的路径。把句柄传给 spawn、或把 OS 路径交给沙箱写入，都会静默破坏沙箱围栏，因此 seam 必须同时显式暴露两者。
- **`workspaceRoot` 必须贯穿每一次 fs 调用**：`ctx.fs.resolve(path)` 的基准是宿主进程的 `process.cwd()` 而非会话工作区，裸 Node 回退更是完全没有「工作区」概念。相对路径的锚定要在 seam 层完成。
- **绝不派发 watch 类命令**：任何可能进入 watch/daemon 模式的命令（`pnpm run dev`、`esbuild --watch`）都可能永不返回。优先用显式的一次性参数，退而只调用项目自身的 **production** 脚本，并始终施加硬超时。
- **子进程结果要分类，不要只看退出码**：非零退出、可执行文件缺失、超时、以及「成功但无输出」是四件不同的事、对应四种不同处置。让 runner 的返回值把它们分开，而不是靠 `status` 推断。
- **静态检查不能被写成「已验证」**：只扫描产物而未真正运行的检查，必须在输出里写明这一点。打包成功不等于被加载过，文件装好也不等于插件可用。
- **区分「已安装 / 已启用 / 已加载」**：安装类工具逐态上报，无法验证的状态写 `unknown` 而不是乐观结论。绝不能让人（或模型）从「文件在那儿」推断出「它能用」。
- **目标解析要有确定顺序，失败要给选项**：显式参数 → 已记住的绑定 → 约定的目录 → 拒绝并列出候选做法。不要创建用户没有要求的目标，也不要在多个候选之间猜。
- **工具 `parameters` 是属性映射表**：`{ name: { type, required?, description } }`，不是 JSON Schema 根。JSON Schema 根会在加载时于工具 API 内抛错，直接让整个插件起不来——用「通过真实校验器注册全部工具」的测试把它锁住。
- **上报残留文件**：安装完成后列出目标目录里意料之外的文件。上一版布局留下的陈旧产物是只在运行期才暴露的失败模式。
