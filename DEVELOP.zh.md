# 开发文档

[🌐 English](./DEVELOP.md) | **🇨🇳 中文**

## 目标

让 DeepSeek Harness（DSH）的智能体可靠地完成 Obsidian 插件的脚手架、构建、部署、真机验证、校验与版本同步，并配套提供开发规范知识（skill）。

## 架构

两个互补、职责单一的部分：

1. **知识（skill）**——Obsidian 插件开发规范（命名/提交规则、无障碍、代码质量、提交与 Scorecard）。源自 [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)，内置为 [assets/skills/obsidian-plugin](assets/skills/obsidian-plugin/SKILL.md)，并在 `apply()` 里通过 `ctx.skills.register` 注册为 runtime skill（不依赖 project root）。
2. **护栏（tool bundle）**——本仓库 `@leelee592/dsh-obsidian-plugin`，用 typed schema 暴露 11 个工具，把确定性操作封装起来：
   - `obsidian_plugin_scaffold` —— 复用 obsidian-sample-plugin 模板生成骨架
   - `obsidian_plugin_build` —— 打包成可加载的 main.js（入口与产物从项目自身配置解析）+ 静态自检
   - `obsidian_plugin_deploy` —— 把构建产物装进 vault 并启用插件 id
   - `obsidian_plugin_inspect` —— 只读观测运行中的 App（status / errors / console / dom / css / screenshot / trustCheck）
   - `obsidian_plugin_vault` —— 管理真机验证用的库（status / ensure / close / prune）
   - `obsidian_plugin_reload` —— 让改动在运行中的 App 生效，并校验插件确实加载
   - `obsidian_plugin_test` —— 离线冒烟：在纯 Node 里用桩化的 Obsidian API 加载构建产物
   - `obsidian_plugin_e2e` —— 脚手架化沙箱端到端测试（WebdriverIO + wdio-obsidian-service）
   - `obsidian_plugin_eval` —— 在运行中的 App 里执行 JavaScript（唯一的高特权工具：需审批、回显执行的代码、代码触及窗口焦点时警告）
   - `obsidian_plugin_validate` —— 结构校验 + eslint-plugin-obsidianmd 检查
   - `obsidian_plugin_version` —— 三处版本同步

```
┌────────────────────────────────────────────┐
│ DSH Host（内置 tools / fs / skill / bash） │
└───────▲──────────────────────────▲─────────┘
        │ 工具(bundle)             │ skill 发现
┌───────┴──────────────────────┐  ┌────────┴───────────────────┐
│ @leelee592/dsh-obsidian-plugin │  │ obsidian-plugin skill（内置）  │
│  11 tools, scaffold…version │  │  SKILL.md + reference/*     │
└─────────────────────────────┘  └─────────────────────────────┘
```

## 验证档位

四档，由浅到深；括号里是执行它的工具：

| 档 | 含义 | 干扰 |
| --- | --- | --- |
| L1 静态 | 产物存在性、模块格式/导出/外部化检查、manifest↔产物一致性（在 `build` 内） | 无 |
| L2 离线冒烟 | 在纯 Node 里用桩化的 Obsidian API 加载产物，真跑一遍生命周期（`test`），报告会点名本次没有覆盖什么 | 无 |
| L3 用户的 Obsidian | 经 CLI 操作用户运行中的 App：`vault` / `reload` / `inspect` / `eval` | 会切换用户的窗口、抢焦点——只用于验证用户的真实环境 |
| L4 沙箱 Obsidian | 独立配置目录 + 库副本的**独立 Obsidian** 跑项目自建的 WebdriverIO 套件（`e2e`）；生成的配置用 `before` 钩子在 spec 运行前隐藏实例窗口 | 无——开发循环的默认档 |

档位表使用短名：`vault` / `reload` / `inspect` / `eval` 即同名的 `obsidian_plugin_*` 工具。

两条规则贯穿所有档位：**只允许修改会话工作区内创建的测试库**（用户自己的库是只读的，包括 CLI 侧的间接写入——`plugin:enable` / `unrestrict` 改写的是当前活动窗口那个库，工具会拒绝对非测试库执行）；**默认路径绝不切换用户的窗口、绝不抢焦点**。

**检查通过不等于验收。** `build` 成功、离线冒烟的 PASS 只证明产物能在桩环境里加载——既不证明插件可用，也不证明 UI 已验证：桩环境没有编辑器。只要改动涉及界面、渲染或交互，就必须真正看到它——沙箱档（`e2e`）或对着运行中的 App（`inspect action=screenshot`）——并在回复里说明看到了什么。这条规则来自真实任务：一次纯粹改 UI 的改动，build + test 全绿就被当成完成，且从未部署，用户什么也没看到。

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
│   ├── build.ts          # obsidian_plugin_build：入口/产物解析 + 构建三级 + 静态自检
│   ├── lookup.ts         # 入口与产物的解析链（配置只扫描、不求值）
│   ├── deploy.ts         # obsidian_plugin_deploy：vault 解析、产物安装、绑定写入
│   ├── inspect.ts        # obsidian_plugin_inspect：只读观测 status/errors/console/dom/css
│   ├── vault.ts          # obsidian_plugin_vault：库注册表、激活阶梯、confirm 闸门
│   ├── reload.ts         # obsidian_plugin_reload：reload/enable/rescan/unrestrict + 加载校验
│   ├── harness.ts        # obsidian_plugin_test：针对构建产物的离线冒烟（L2）
│   ├── e2e.ts            # obsidian_plugin_e2e：沙箱化 E2E 脚手架（L4）
│   ├── eval.ts           # obsidian_plugin_eval：在运行中的 App 执行 JS（必审）
│   ├── cli.ts            # obsidian CLI 调用：超时 + 按输出分类失败
│   └── bundle-doc.ts     # 读取包内 doc/ 资源
├── test/
│   ├── p0.test.ts        # node:test 跑在 lib/ 上（裸 Node，无需 harness）
│   ├── p1.test.ts        # node:test 跑在 lib/ 上：CLI 分类、eval 解析、argv、截断
│   ├── p2a.test.ts       # node:test 跑在 lib/ 上：入口/产物解析链
│   ├── p2b.test.ts       # node:test 跑在 lib/ 上：离线冒烟 harness
│   ├── p2c.test.ts       # node:test 跑在 lib/ 上：e2e 脚手架
│   └── p3.test.ts        # node:test 跑在 lib/ 上：eval 护栏
├── scripts/
│   ├── link-dsh-deps.mjs # 链接 $DSH_HOME 的 @deepseek-ai 类型
│   └── deploy.sh         # build + 注册工具 + dump-config 验证
├── assets/
│   ├── templates/        # obsidian-sample-plugin 模板（14 个文件，含占位符）
│   ├── harness/          # L2 离线冒烟用的 obsidian 桩与 scenario 装载器
│   ├── e2e/              # obsidian_plugin_e2e 脚手架用的 WebdriverIO 模板（L4）
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
- **读取必须自证目标**：只要命令的目标依赖外部状态（哪个窗口在前台、选中了哪个项目），就在**同一次读取**里返回身份标识——这里是数据和 `app.vault.getName()` 一起返回。用另一次探测去推断目标，正是「读数悄悄来自错误位置」的成因。
- **退出码永远不能覆盖输出**：打印 `Error: …` 却仍以 `0` 退出的 CLI 会击穿所有基于状态的判定。按输出分类，并把「成功但没有任何输出」单独归为一类，因为静默超时不是成功。
- **状态存在于你的进程之外**：另一个应用会缓存它读到的东西，写文件不会让对方看见。在「已写入」和「对可见」之间插入一次显式重新索引，而不是留给调用者去发现。
- **一次只暴露一层安全开关**：作用于某个作用域的安全设置（这里是逐库受限模式）绝不能成为其它操作顺带的副作用。给它独立动作，并写明后果与影响范围。
- **依赖前台状态的步骤要一次做完**：如果某操作依赖外部焦点，就把需要它的步骤连续执行。用户在两次工具调用之间切一下应用，就可能让前一次的铺垫失效。
- **不要写死项目的目录布局**：入口与产物目录是约定，不是事实。真实插件的入口有 `src/main.ts`、仓库根 `main.ts`、`src/plugin/main.ts` 等形态，产物可能落在项目根、测试库内或 `dir: '.'`。两者都要从项目自身的配置解析（显式参数 → 约定 → 配置 → `package.json`），失败时列出全部尝试过的位置，让调用方能行动而不是靠猜。
- **只要存在配置就优先用项目自己的构建脚本**：打包配置可能带着我们无法从命令行补齐的插件（esbuild-svelte、esbuild-sass-plugin）。只有在没有配置可遵循、或调用方显式选择时才用我们自己的参数——并且此时必须警告「项目插件未被应用」。
- **配置只扫描，绝不求值**：为了找 `outfile` / `outdir` 而读取打包配置时，不得执行项目代码，何况 `dev` 配置会进入 watch 模式。按文本解析。
- **验证档位要标明，不要含混**：静态扫描、离线桩、沙箱实例与用户自己的 App 各自证明的东西不同。说明结论出自哪一档、可信度到哪里为止——桩环境不能证明运行期行为。
- **要消除干扰，而不是把干扰压到最小**：当某项操作的代价是用户的注意力（切窗口、抢焦点），就用「独立实例 + 独立配置目录 + 数据副本」把它从根上消掉，而不是尽量少做。
- **沙箱看不见别的进程做的写入**：`plugin:enable` / `unrestrict` 改写的是另一个 App 当前在前的那个库，任何文件级策略都拦不住。执行这类命令前先校验目标身份，并把可写集合限制在沙箱自己创建的东西上。
- **脚手架要交付「可运行态」，不只是「文件已写」**：生成物引用到的任何东西（库、目录、凭据路径）都必须在生成时校验是否存在，不存在就一并创建；否则第一次运行就会栽在生成器本来就能预知的事情上。「已生成」和「生成后即可运行」是同一个承诺。
- **忽略生成目录要忽略内容，不要忽略目录本身**：`.gitignore` 里整目录排除（`e2e/vault/`）会把「新克隆也需要的那份空目录」一起排除掉。应写成 `<dir>/*` 再反忽略一个标记文件——否则你刚修掉的那类失败会在别人的机器上原样复现。
- **要关掉 App 自己决定的行为，就在 App 里关，而不是在启动参数上**：应用若在自举时自己创建并显示窗口，任何启动开关都拦不住，无论那开关看起来多合理；所有候选都必须**实测**，全部无效时，最早的应用内钩子就是答案。同理，先读框架自己的选项面再动手写绕行方案：确认「它没有这个选项」才是绕行的正当理由。
- **验收是「亲眼看到」，不是「检查通过」**：build 全绿、桩环境冒烟 PASS 只证明产物能加载，仅此而已——桩环境没有编辑器，证明不了可见改动真的生效。当改动是可见的（界面、渲染、交互），循环的终点是「在运行中的 App 里看到它」——沙箱档 e2e 或 screenshot——并在回复里写明看到了什么。
