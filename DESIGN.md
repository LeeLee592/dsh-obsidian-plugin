# DESIGN · 打通 Obsidian 插件开发的完整流程

> 面向对象：本仓库维护者与实现者。
> **本文档中所有「已实测」条目均在 macOS 15.7.9 + Obsidian 1.13.7（installer 1.13.7）上跑通并记录；「待验证」条目明确标注。**
> 现状一句话：本插件目前覆盖「生成骨架 → 写代码 → 静态校验 → 改版本」，缺「装进 Obsidian → 跑起来 → 看现象 → 定位问题」这后半程。
>
> **两条贯穿全文的硬约束（先读这两条）**：
> 1. **只写工作区内创建的 TestVault，禁止修改用户的 Vault**（含通过 CLI 间接改写）——见 §2.10；
> 2. **默认不打扰用户**：不得切换用户窗口、不得抢焦点；`vault-open` 是唯一会切窗的动作，默认路径不允许出现——见 §2.9。

---

## 1. 现状与缺口

### 1.1 已具备（0.3.0）

| 环节 | 承载物 | 说明 |
|---|---|---|
| 脚手架 | `obsidian_plugin_scaffold` | 复用 obsidian-sample-plugin 模板生成 14 个文件 |
| 实现 | `obsidian-plugin` skill | 插件编写规范（内存/类型/UI/无障碍/CSS/代码质量） |
| 静态校验 | `obsidian_plugin_validate` | manifest/命名/版本一致性 + eslint-plugin-obsidianmd |
| 版本 | `obsidian_plugin_version` | 三处版本同步 |

### 1.2 缺口

1. **装不进去**：模板的 `pnpm run dev` 只在项目根产出 `main.js`，不写入任何 vault；安装到 `.obsidian/plugins/<id>/` 并启用目前只能靠人肉拷贝。
2. **跑不起来**：即便装好，agent 无法确认插件是否真被加载、命令是否注册、有没有报错。
3. **看不见现象**：缺截图 / DOM / CSS / 控制台 / 异常这几路观测量。
4. **定位不了问题**：没有「在真实运行时的 Obsidian 里观察与试验」的手段（`app`、`app.plugins.plugins[id]`、真实 vault 数据都够不着）。

### 1.3 设计目标

```
scaffold → implement → build → test → deploy → enable/reload → inspect/eval → 修复 → validate → version → 提交
   ✅        ✅         ❌      ❌      ❌          ❌              ❌                    ✅        ✅
```

**新增的每一环必须满足**：

- **用官方能力，不自研协议层**：观察面优先复用 Obsidian 自带 CLI；缺口再补。
- **不引入第三方运行时依赖**：沿用 `node:child_process` 底座。
- **失败要说人话**：任何环境/权限/时序问题都返回可执行的下一步，而不是 stack trace。
- **不替用户做安全决定**：涉及用户 App 设置（信任 / 受限模式）与窗口布局的动作一律走确认。
- **沙箱诚实**：DSH 沙箱只约束本插件自己的文件写入；spawn 出去的子进程（`obsidian` CLI、esbuild、`open`）不受其约束。

---

## 2. 实测事实（全部为本次验证结论，是后续设计的依据）

> **最关键的一句话**：真机链路的组成部件（沙箱、CLI、eval、截图、错误缓冲）**全部可用**，难点不在「能不能做到」，而在**时序、窗口归属、以及一个必须由用户拍板的安全开关**。

### 2.1 沙箱模型（macOS Seatbelt）

DSH 在 macOS 用 `sandbox-exec` + SBPL 限制，profile 形如（见 `dsh-sandbox-local/lib/index.js`）：

```
(version 1) (allow default) (deny file-write*) (allow file-write* (subpath <workspace>) (subpath /tmp…))
```

**只限制文件写入，不限制进程派生与 IPC。** 实测：

| 动作 | 结果 |
|---|---|
| 沙箱内 `obsidian version` / `vault` / `plugin id=` | ✅ 正常（IPC 通道可用） |
| 沙箱内 `open -a Obsidian`（App 已运行） | ✅ rc=0 |
| 沙箱内 `sandbox-exec …` 嵌套 | ❌ `sandbox_apply: Operation not permitted` |
| 沙箱内 `dev:screenshot path=<workspace>/x.png` | ✅ 文件写入工作区成功 |

→ 结论：**测试库放工作区内，沙箱全程无阻碍**；只有「装进用户工作区外的真实库」才需要提权。

### 2.2 CLI 调用模式与会话约束

- **命令行形式可用**（`obsidian <command> param=value`），TUI 形式不需要。
- **调用必须包超时**：实测 `dev:screenshot`、`plugin:reload`、`dev:errors` 都出现过**静默挂死**（stdout/stderr 全空、退出码 0）。**「空输出」必须单独判定为挂死**，否则会被误判成「成功但无输出」。
- **出错也会返回 exit 0**：判定要看输出内容（`^Error:` 前缀），不能看退出码。
- **三种失败要分开**：`Error: Command "x" not found`（命令面不适用）≠ `Error: …` 业务错误 ≠ **空输出（挂死）**，恢复动作各不相同。
- **故障率可观**：本次会话内 `dev:errors`/`eval`/`dev:screenshot` 各出现过 1～2 次超时，重试即恢复。→ 工具必须有**重试 + 健康探测**，不能一次超时就报失败。

### 2.3 vault 注册表与窗口归属（决定「目标库」怎么选）

- 注册表：`~/Library/Application Support/obsidian/obsidian.json` → `{vaults:{<opaqueId>:{path,ts,open?}}}`；**vaultId 不是路径哈希**（md5/sha1/sha256 均不匹配），**不要手写该文件**。
- 要打开/注册一个库，官方未提供文档化入口，但**渲染进程内部 IPC 通道可用（已实测）**：

  ```js
  obsidian eval code='electron.ipcRenderer.sendSync("vault-open","<绝对路径>",false)'
  → => true            // 未注册的文件夹会被登记 + 打开
  ```

  `electron` 是渲染进程全局对象（`app` / `module` / `require` 同样暴露），这条通道正是 Obsidian 自身「换库」弹窗 `DI` 的实现（源码：`onChooseItem → sendSync("vault-open", path, false)`）。

- **命令面的窗口归属（重要）**：

  | 命令族 | 解析依据 | 证据 |
  |---|---|---|
  | `plugin` / `plugin:reload` / `plugin:enable` / `plugins:enabled` / `dev:*` / `eval` / `command` | **活动窗口的库** | 活动库为 `Notes` 时 `plugin:reload id=<其他库的插件>` → `Plugin "x" not found`；`vault-open` 到目标库后同一命令 → `Reloaded` ✅ |
  | `vaults` / `version` / `plugins:restrict` | 与窗口无关（App 级信息） | 在任意 CWD 下均可返回 |

  **`vault=<name>` 不能可靠地把 `plugin:*` / `dev:*` 重定向到非活动库**：实测对非前台库调用要么超时、要么报 `Command "x" not found`。
  ⚠️ 一次早期观测（活动库未确认时 `plugin:enable` 返回 `Enabled: …`）曾被误读为「跨窗口成功」；按时间线复核（目标库的 `community-plugins.json` 在两天后才被写入）该输出**很可能来自当时的活动库**，故不作为证据。

  → **铁律：先 `vault-open` 把目标库带到前台，再执行任何 `plugin:*` / `dev:*` / `eval` 命令**；否则既有「命令不存在」的误判，也有**打到错的库上**的风险。

### 2.4 信任弹窗（首次打开带插件的库时的阻塞点）

**触发**：库里有 `community-plugins.json` 非空 + **该库**处于受限模式 + 窗口首次加载 → 弹出 `mod-trust-folder` 模态框：

- 标题 i18n key `setting.thirdPartyPlugin.labelTrustAuthor`；
- 按钮 1 = `buttonDontTrustAuthor`（取消，**什么都不做**）；
- 按钮 2 = `buttonEnablePlugins`，实现是：

  ```js
  await this.app.plugins.setEnable(true)   // ← 关闭【当前库】的受限模式，随后重载 App 窗口
  this.app.setting.open(); this.app.setting.openTabById("community-plugins")
  ```

**三条硬事实**：

1. **判定依据是「每库 × 每 App 实例」的受限模式**，而不是 `obsidian.json` 里的 trust 字段——该文件的 vault 条目只有 `path/ts/open`，vault 内 `app.json` 是空 `{}`。持久化实现（app.js）：

   ```js
   setEnable = function (e) { localStorage.setItem("enable-plugin-" + this.app.appId, e ? "true" : "false"); … }
   isEnabled = function ()  { return "true" === localStorage.getItem("enable-plugin-" + this.app.appId) }
   ```

   实盘（活动库 TestVault）：`enabled: true`，且 localStorage 中并存 `enable-plugin-<各库 appId>=true`。
   → **信任是逐库生效的**：信任测试库不会连带放行用户的其它库；但「写个 per-vault 字段绕过弹窗」依然不存在，因为判定读的是 localStorage 而非 vault 配置文件。
2. **「已启用」与「已加载」必须分开判定**：`community-plugins.json` 只是启用清单（受管于 `enable-plugin-<appId>` 之外），在受限模式下**清单可以被写入，但插件不会被加载**。→ 报告里必须区分「已写入 / 已启用 / 已加载」三态，并以 `app.plugins.plugins`（或 `plugin id=` 的 `enabled`）作为「已加载」的唯一依据。
3. **点击「信任」会重载 App 窗口**，因此**发起点击的那次 `eval` 不会返回**（实测超时）——这是预期行为，不是失败。

**检测锚点（实测可用）**：`dev:dom selector=".mod-trust-folder" total`。注意弹窗是**异步渲染**的：`vault-open` 返回后立刻查可能得到 `No elements found.`，需要**带重试地轮询**（本次实测：30s 后查询命中 `1`）。

### 2.5 观察面实测结果

| 能力 | 命令 | 实测结果 |
|---|---|---|
| 插件装载状态 | `plugin id=<id>` | ✅ 输出 type/name/version/author/**enabled**/description |
| 插件实例 | `eval code='Object.keys(app.plugins.plugins)'` | ✅ 返回 `["feishu-style-editor"]`；`enabledPlugins` 同步 |
| 热重载 | `plugin:reload id=<id>` | ✅ `Reloaded: feishu-style-editor` |
| 异常缓冲 | `dev:errors` | ✅ `No errors captured.`（未附加调试器也可用） |
| 控制台缓冲 | `dev:console` | ⚠️ **需先 `dev:debug on`**，否则 `Error: Debugger not attached. Use "dev:debug on" to start capturing console messages.`；附加后能读到 CLI 自身命令日志 |
| 截图 | `dev:screenshot path=<abs>` | ✅ 写出 1184×1600 PNG（**只截 Obsidian 窗口**，非全屏）；文件写入成功但命令可能挂住不返回 |
| DOM | `dev:dom selector=… total\|text\|all` | ✅ 可用，用于弹窗检测与 UI 断言 |

### 2.6 已实测的失败模式清单（实现时必须处理）

| 现象 | 根因 | 处理 |
|---|---|---|
| **附加调试器后 `plugin:reload` 挂死** | `dev:debug on` 与其它命令冲突（本次复现 2 次；`dev:debug off` 后立即恢复） | 「读 console」必须在**独立窗口期**进行：attach → 读 → **立即 detach**，期间不跑 reload |
| 命令静默超时（空输出） | IPC 卡顿 | 重试（1～2 次）；连续失败则判「App 无响应」并给出重启/重注册指引 |
| `vault-open` 后立刻查 DOM 得到空 | 窗口异步渲染 | 轮询等待（带上限） |
| 目标库不在前台 → `Command/Plugin "x" not found` | 命令面按**活动窗口**解析 | 先 `vault-open` 把目标库带到前台，并在同一次读数里自证身份（见 §7 第 5 条） |
| 端口/焦点被抢 | App 自身行为 | 提前告知用户；测试完可关闭窗口 |

### 2.7 复核修订记录（本版相对上一版的更正）

本文档在提交后经过一次专项复核，以下条目被**更正或降级**，实现时以本版为准：

| 原结论 | 更正后 | 依据 |
|---|---|---|
| `plugin:enable` 是 App 级命令，`vault=` 可跨窗口定向 | **全部 `plugin:*` / `dev:*` / `eval` 按活动窗口解析**；`vault=` 对它们不可靠 | 活动库为 `Notes` 时 `plugin:reload` 报 `Plugin "x" not found`；`vault-open` 到目标库后同一命令返回 `Reloaded` |
| 信任弹窗会关闭**全局**受限模式 | 受限模式是**每库 × 每 App 实例**（localStorage `enable-plugin-<appId>`） | app.js 的 `setEnable`/`isEnabled` 实现 + 实盘 localStorage 键 |
| CLI 完成 enable 的跨库操作已实测 | 该输出的**目标库未确证**，降级为「部分验证」 | 目标库 `community-plugins.json` 的 mtime 晚于部署两天 |
| 文档同步清单使用 `README{,.en}.md` 等旧名 | 仓库已改为 `README.md` / `README.zh.md`（英文默认）+ `README.i18n.yaml` | 仓库现行文件 |
| 缺失 | **新增 §7 第 5 条「观测必须自证身份」**：读窗口级数据时须在同一次读数里返回 `app.vault.getName()` | 复核中曾误把用户真实库的插件列表当作 TestVault 的数据，根因是仅凭「CLI 报告的活动库」推断目标 |
| 「三档验证」中 L3 是唯一的真机档 | **改为四档**：L3（用户实例）+ **L4（沙箱实例，零干扰，新增为默认档）** | 真实使用反馈：操作 TestVault 时窗口被反复切走（§2.9） |
| 「调用 CLI 就会切换窗口、抢焦点」 | **收窄**：实测仅 **`vault-open`** 会切换窗口；`version` / `vaults` / `vault info=` 等 App 级查询不切，作用于非前台库的 `plugin:*` / `dev:*` 只是失败而不拉窗口。抢焦点是**我们主动调用 `vault-open`** 的结果，因此默认路径完全可以不含切窗动作 | 逐命令实测对照（§2.9 表格） |
| 未受控的写入范围（原设计只考虑沙箱能否拦住） | **新增 §2.10 硬门禁**：只写工作区内 TestVault，用户库只读；并显式处理**沙箱子拦截不到的间接写入**（`plugin:enable` / `unrestrict` 改写活动窗口那个库） | 用户要求；且 `plugin:*` 按活动窗口解析这一实测事实意味着可能改到用户的库 |
| 约束层级为 4 级（安全决定 / 工作环境 / 可靠性 / 能力） | **改为 5 级**，且**数据边界成为第 ① 级**（高于安全决定与窗口打扰）：「宁可不做，也不越界」 | 同上 |
| 入口固定 `src/main.ts`、产物固定项目根 | **两者都改为解析链** | 11 个头部插件抽样：入口有 3 种形态（含根 `main.ts`），产物有 3 种落点（含测试库内）；editing-toolbar 用原实现直接构建失败（§2.8） |
| 离线冒烟只需桩 `obsidian` | **顺序有依赖**：宿主环境 → 桩 → 项目真实 `@codemirror/*` → 产物；且需 project jsdom 与宿主全局 | 真实插件探针：`self is not defined` / `StateEffect.define is not a function` / `moment.locale is not a function`（§2.8） |

### 2.8 真实插件抽样：插件开发场景与注意事项

**抽样范围**：官方索引 `obsidianmd/obsidian-releases` 的 `community-plugins.json`（**7722 个插件**）中选取 11 个跨类别头部插件（dataview / Templater / obsidian-tasks / kanban / calendar / excalidraw / obsidian-git / recent-files / minimal-settings / style-settings / cmdr），逐个读取其构建配置、入口、产物落点与测试基建。

**构建与产物形态的真实分布**

| 维度 | 分布 |
|---|---|
| 构建器 | esbuild 7 · rollup 3 · 其他 1 |
| 入口 | `src/main.ts`（多数）· **仓库根 `main.ts`**（obsidian-tasks、recent-files）· `src/plugin/main.ts`（editing-toolbar） |
| 产物落点 | 项目根 `main.js`（多数）· `dir: '.'`（obsidian-tasks、kanban）· **直接输出进各自的测试库**（dataview → `test-vault/`，editing-toolbar → `Editing-Toolbar-Test-Vault/`） |
| 测试基建 | 两极分化：obsidian-tasks 177 个测试、dataview 18 个、obsidian-git/cmdr/style-settings 用 vitest；**其余多为 0** |
| 宿主环境 | jest+jsdom（dataview、obsidian-tasks）、vitest jsdom（cmdr）、vitest node（obsidian-git）、**wdio-obsidian-service（Templater）** |

**这些真实形态直接否定掉我们原有的两个假设**：

1. **入口不能硬编码 `src/main.ts`**——已实测：用我们的 `build` 构建 editing-toolbar 直接报 `entry point not found`（它的入口是 `src/plugin/main.ts`）。
2. **产物不一定在项目根**——dataview 与 editing-toolbar 都把产物写进各自的测试库，我们的产物发现逻辑必须解析项目的构建配置，而不是假定路径。

**必做注意项（多为实测所得，按优先级）**：

| # | 注意项 | 证据 | 对策 |
|---|---|---|---|
| 1 | Obsidian 只在库加载时扫一次插件目录 | P1 实测 `Plugin "x" not found` | `reload action=rescan`（已实现） |
| 2 | 受限模式逐库阻止加载 | P1 实测 `not enabled` | 显式 `unrestrict`（已实现） |
| 3 | **`@codemirror/*`、`@lezer/*` 不能用桩替代** | 桩化后 `StateEffect.define is not a function` | 离线冒烟必须用**项目自己的真实依赖** |
| 4 | **DOM 宿主是刚需**（多数插件加载期即访问 document） | `self is not defined`；dataview/cmdr 均以 jsdom 为宿主 | 允许项目自带的 jsdom；缺失时明确报出 |
| 5 | **Obsidian 注入的全局**（`moment` 等） | editing-toolbar 报 `e.moment.locale is not a function` | 桩补齐宿主全局 |
| 6 | 产物导出形态不一（`.default` vs 直接导出） | rollup `exports: "default"` vs esbuild 默认 | 冒烟同时接受两种 |
| 7 | 未实现的 API 必须显式报错 | 否则排障成本极高 | 桩抛 `Not implemented in the offline stub: <name>` |
| 8 | 部分插件访问未公开内部 API | obsidian-tasks 使用社区维护的 `obsidian-typings` | 不在工具层做限制，但文档需说明其风险 |

### 2.9 抢焦点是怎么发生的（新增；已按实测修正范围）

**先纠正一个过宽的表述**：**并非所有 CLI 命令都会切换窗口**。实测对照（同一会话内，观察 `vault info=name` 是否变化）：

| 命令 | 是否切换窗口 |
|---|---|
| `version` | 否 |
| `vault info=name` | 否 |
| `vaults`（列举已注册库） | 否 |
| `plugins:restrict` | 否 |
| `plugin:*` / `dev:*` / `eval`（作用于**非前台**的库） | 否——它们**直接失败**（`Command/Plugin "x" not found`），而不是把窗口拉起来 |
| **`vault-open`**（即我们 `ensure` 的执行动作） | **是**，这是唯一真正切换窗口、抢走焦点的动作 |

**结论**：抢焦点**不是 CLI 的固有行为，而是我们自己的选择**——每次观测前为了让 `plugin:*` / `dev:*` 能落到目标库，我们主动调用了 `vault-open`。这一点很重要，因为它把问题的性质改了：**我们完全可以选择不这么做**（P2c 的 L4 沙箱实例），而不是只能「尽量少做」。

**为什么仍然必须极力避免**：一旦发生，代价是用户的注意力——窗口被切走、鼠标焦点被夺，开发期间无法做别的事；macOS 上还可能连带切换 Space。P1 的 `ensure confirm=true` 只做到「显式且在预期内」，**没有消除代价**。

**需要极力的避免原则（替代原来的「三档里的一档」定位）**：

1. **默认路径不得包含任何 `vault-open`**（L1/L2/L4 都满足）；
2. L3 中除「首次登记一个**工作区内**的测试库」外，**不得**为避免命令失败而顺手 `vault-open` 用户的库；
3. 任何会切换用户窗口的动作，必须在返回值里**显式声明**「本次操作把 Obsidian 切到了前台」，让调用者与用户都看得见；
4. 能在 L4 沙箱实例里完成的事，一律不在用户实例上做。

**解法方向：沙箱化实例**。社区已有成熟方案 **`obsidian-launcher`**（v3.2.0），其 README 的原文能力声明正好命中我们的痛点：

> *"download and launch different versions of Obsidian, install plugins and themes into Obsidian vaults, and launch **sandboxed Obsidian instances with isolated user configuration directories**"* —— 并明确说明 *"so you don't need to worry about it interfering with your system Obsidian installation"*，且可**并行启动多个版本**。

它还提供了几项我们正需要的能力：

- `copy: true` —— **打开库的副本**，测试过程不改动原库；
- `plugins: [...]` —— 按路径安装**本地插件**、按 id 安装**社区插件**；
- `appVersion: "earliest"` —— **自动取插件 `manifest.json` 里的 `minAppVersion`** 作为测试版本，直接对我们的 A12（多版本兼容）给出实证；
- 区分 `appVersion` 与 `installerVersion`，可在不同 Electron 基座上也验证一遍。

`wdio-obsidian-service`（v3.2.0）在它之上提供 WebdriverIO 服务：多版本、沙箱隔离、库切换、CI。

**关键判断**：沙箱实例拥有**独立的用户配置目录**（受限模式、库注册表、其它插件都干净，不受用户配置影响），打开的是**库副本**，并且**永远不需要用户窗口进入前台**。因此它让「默认路径不含任何切窗动作」从原则变成可落地的事实——用户的 Obsidian 可以一直保持不动，而验证仍然跑在真实的 Obsidian 运行时里。

**因此真机验证分裂为两档**（详见 §3.3）：

- **L3 用户实例**：验证「插件的**真实使用环境**」（用户自己的库/窗口/配置），代价是抢焦点，须显式确认、少用；
- **L4 沙箱实例**：验证「插件在**真实 Obsidian 运行时**中的行为」，**零干扰**，可反复、可并行、可多版本，适合日常循环与 CI。

### 2.10 写入范围门禁：只写工作区内的 TestVault（新增，硬约束）

**规则（不可协商）**：本插件**只允许修改工作区内创建的测试库**；**禁止修改用户的任何 Vault**。

这条规则比「沙箱能拦就拦」更严，因为它针对的是两类沙箱管不住的情况：

1. **通过 CLI 间接改写用户的库**：`plugin:enable` / `plugin:disable` 会改写**当前活动窗口那个库**的 `community-plugins.json`。沙箱对此**完全无效**——写盘的是 Obsidian 进程，不是我们。实测已确认这类命令按活动窗口解析，也就是说：**我们可能在用户毫不知情时改掉了用户库的插件启用列表**。
2. **把用户的库当成测试目标**：真实使用中完全可能出现「顺手在你的库里试试」，而用户的库里有真实笔记、真实插件配置。

**四级门禁模型**：

| 级别 | 对象 | 规则 |
|---|---|---|
| 读-自由 | 工作区内 TestVault | 读写皆可 |
| 读-受限 | 用户的库（`inspect` / `status` 等只读观测） | **仅只读**，且必须显式指定目标；返回值须标明「本次读的是用户的库」 |
| 写-禁止 | 用户的库（任何写入：拷贝产物、改 enable 列表、改受限模式、改窗口状态） | **默认一律拒绝**；唯一的放行方式见下方「例外通道」 |
| 写-自由 | 沙箱实例（L4）的库 | 读写皆可——沙箱实例用的是**库副本**与独立用户配置目录，天然不触碰用户数据 |

**代码级校验（不只靠约定）**：

- **写前校验**：`deploy` / `vault` 的所有写入动作，在执行前校验目标路径 —— 必须位于工作区内，且符合测试库约定（`<workspace>/…/TestVault` 或 `dsh.obsidian.json` 中已登记的**工作区内**库）。任一条件不满足即**拒绝写入**并给出说明；
- **CLI 写前校验**：执行 `plugin:enable` / `plugin:disable` / `unrestrict` / `rescan` 等**会改写目标库**的命令前，先读活动库身份（`app.vault.getName()` + 路径），确认它就是工作区内的测试库；**不是则拒绝执行**。这条正是为了堵住「沙箱管不到的间接改写」；
- **越界文案**：拒绝时必须说清三件事——目标路径、为什么被拒（不在工作区 / 不是测试库）、以及可选的下一步（在工作区内建测试库 / 走 L4 沙箱实例 / 手动操作）。

**唯一的例外通道（显式、逐次、可审计）**：用户可能在极少数情况下确实要求「装到我自己的库」。此时通过一个显式参数（例如 `target=user-vault` 加一次确认）放行，并且：

- 只对**这一次调用**生效，不写入任何持久配置；
- 返回值中明确标注「已按你的显式授权写入用户库 <path>」；
- 默认绝不开启，也不提供「永久允许」的开关。

**与 L4 的关系**：L4 沙箱实例使用的是**库副本**（`copy: true`）与独立用户配置目录，因此「随意写测试库」在 L4 上是完全安全的。这也是为什么 P2c 之后**默认路径根本不需要碰用户的东西**——门禁与默认档在方向上是一致的。

---

## 3. 总体设计

### 3.1 分层架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│ DSH Host（tools / fs / skill / bash / subprocess）                        │
└──────▲───────────────────────────────────────────────────────────────────┘
       │ 11 个工具（已实现 8）
┌──────┴───────────────────────────────────────────────────────────────────┐
│ @leelee592/dsh-obsidian-plugin                                            │
│  【接口层】 scaffold · build · deploy · inspect · vault · reload ·        │
│            validate · version                       （已实现）            │
│            test · e2e · eval                        （P2 / P3）           │
│  【能力层】 buildRunner │ vaultDeployer │ smokeHarness │ obsidianBridge    │
│            e2eScaffolder（生成 wdio 骨架；依赖留给用户项目）              │
│  【底座层】 ctx.fs（受沙箱） · spawnSync（CLI/esbuild/wdio，不受沙箱）    │
└──────────────────────────────────────────────────────────────────────────┘
       │ 写 .obsidian/plugins/<id>/                 │ CLI（IPC）+ eval（内部通道）
       ▼                                            ▼
┌──────────────────────────────┐        ┌──────────────────────────────────┐
│ TestVault（工作区内，默认目标）│        │ L3 用户 Obsidian（会抢焦点）      │
│ · .obsidian/plugins/<id>/    │        │ L4 沙箱实例（独立 userData，零干扰）│
│ · .obsidian/community-plugins│        │ · 插件实例/命令/视图              │
└──────────────────────────────┘        │ · console/errors/DOM/截图         │
                                        └──────────────────────────────────┘
```

### 3.2 约束层级（设计必须按这个顺序退让）

```
① 用户的数据边界：绝不写用户的 Vault（只写工作区内 TestVault；CLI 的间接改写同样受控）  ← §2.10，硬门禁
② 用户的安全决定（是否信任仓库 / 是否退出受限模式）        ← 永不由 agent 代做
③ 用户的工作环境（不切走用户的窗口、不抢焦点）             ← 由 L4 沙箱实例从根上消解，而非「尽量减少」
④ 可靠性（挂死、时序、窗口归属都要有降级路径）
⑤ 能力覆盖（尽可能多自动化）                             ← 最后才牺牲
```

①②③ 的顺序是刻意的：**宁可不做，也不越界**。降级到更低能力的档位（L2 → L1）永远优于触碰用户的数据或窗口。

### 3.3 四档验证深度

| 档 | 手段 | 覆盖 | 前置 | 干扰 | 工具 |
|---|---|---|---|---|---|
| **L1 静态** | 产物存在性、CJS/导出/external 检查、manifest↔产物一致性 | 结构错误、忘构建、版本漂移、obsidian 被打包 | 无 | 无 | `build` 的返回段 |
| **L2 离线冒烟** | Node 内 `Module._load` 拦截 `obsidian` 桩 + 项目真实 `@codemirror/*`、可选的 project jsdom，真跑 `onload()`/`onunload()` | 加载崩溃、注册缺失、清理泄漏、`minAppVersion` | Node | 无 | `test` |
| **L3 用户实例** | `vault-open` + `plugin:enable` + `plugin:reload` + `dev:*` + `eval`，作用于**用户自己的 Obsidian** | 插件的**真实使用环境**：用户真实的库、配置、其它插件共存 | 用户 App 在运行 + CLI | **抢焦点、切窗口** | `vault` / `reload` / `inspect` / `eval` |
| **L4 沙箱实例** ✨ | 下载并启动**独立的 Obsidian 实例**（独立 userData + CDP 驱动），在其中装插件、跑断言 | 真实运行时行为，且**可反复、可并行、可多版本**（可测 `minAppVersion` 兼容性） | 能下载 Electron/Obsidian | **零干扰**（用户窗口始终不动） | `e2e`（脚手架）+ 项目自建的 wdio 套件 |

**为什么 L4 是必要的，而不是可选优化**：L3 的代价是**用户的注意力**——实测中每次观测都要把测试库带到前台，用户在开发期间无法做别的事。L4 用「独立实例 + 独立 userData」把这个代价直接从架构上消除，因此**日常循环默认走 L4**，L3 只在「必须验证用户真实环境」时使用。

**降级顺序**：L4 不可用（无网/无法下载）→ L3（需用户确认，且明确告知会抢焦点）→ L1+L2，并在结论中标注可信度边界。

### 3.4 工具集合（3 → 11）

| 工具 | 状态 | 职责 | 审批 |
|---|---|---|---|
| `obsidian_plugin_scaffold` | 既有 | 生成骨架 | 免 |
| `obsidian_plugin_validate` | 既有 | 静态校验 | 免 |
| `obsidian_plugin_version` | 既有 | 三处版本同步 | 免 |
| `obsidian_plugin_build` | ✨ | esbuild 打包 + L1 自检 | 免 |
| `obsidian_plugin_deploy` | ✨ | 安装到 vault + 启用 | 免（工作区内） |
| `obsidian_plugin_test` | ✨ | 离线冒烟（L2） | 免 |
| `obsidian_plugin_vault` | ✨ | 库发现/激活/首次信任引导/回收 | 有桌面副作用时询问 |
| `obsidian_plugin_reload` | ✨ | 重载/启停（内循环高频） | 询问 |
| `obsidian_plugin_inspect` | ✨ | 只读观测：status/errors/console/dom/css/screenshot | 免 |
| `obsidian_plugin_eval` | ✨ | 高特权：在 App 上下文执行 JS | **必问** |
| `obsidian_plugin_e2e` | ✨ | 为项目接入沙箱化 E2E（L4）脚手架 | 免（只在项目内写文件） |

> 合计 11 个（已实现 8：scaffold / build / deploy / inspect / vault / reload / validate / version；待实现 3：test / e2e / eval）。其中 `validate`/`version` 属「发布链」，`build`/`test`/`deploy`/`e2e`/`vault`/`reload` 属「运行链」，`inspect`/`eval` 属「观测链」。

**拆分依据不是动作数量，而是审批粒度**：DSH 的审批挂在工具级（`tools/pre-execute`）。把 `eval` 混进只读工具会让每一次「看一眼日志」都过闸。约定：**能用 `inspect` 回答的，绝不升级到 `eval`**——绝大多数迭代走免审路径。

---

## 4. 工具详细设计

### 4.1 `obsidian_plugin_build`

**职责**：把插件入口打成可加载的 `main.js`，并做 L1 自检。

**入口点解析链（§2.8 证据驱动，必须修）**：显式参数 → `src/main.ts` → **`main.ts`（仓库根）** → 从项目构建配置读取（`esbuild.config.mjs` 的 `entryPoints`、`rollup.config.*` 的 `input`）→ 明确报错并列出候选位置。实测形态：`src/main.ts`（多数）、根 `main.ts`（obsidian-tasks、recent-files）、`src/plugin/main.ts`（editing-toolbar）。

**产物发现链（§2.8 证据驱动，必须修）**：项目根 `main.js` → 项目根 `.obsidian/plugins/<id>/main.js` → 从构建配置解析输出目录（`outfile` / `dir` / `file`，rollup 的 `output.dir`）→ 在项目内按 `<id>/main.js` 搜索一次 → 报错并列出尝试过的位置。实测形态：根 `main.js`（多数）、`dir: '.'`（obsidian-tasks、kanban）、**测试库内路径**（dataview → `test-vault/.obsidian/plugins/dataview`，editing-toolbar → `Editing-Toolbar-Test-Vault/...`）。

**降级档（逐级在返回值中标注用了哪一级）**：

1. 项目有 `node_modules/.bin/esbuild` → 直接调二进制（`--bundle --external:… --format=cjs --target=es2018 --platform=browser --outfile=<解析出的产物路径>`）。不依赖 `pnpm` 是否存在，也不受项目自身 `esbuild.config.mjs` 是否进入 watch 影响。
2. 无本地 esbuild 且项目有 `build` 脚本 → 调 **production** 脚本（`pnpm`/`npm run build`），随后走产物发现链定位结果。**rollup 工程靠这一档覆盖**（实测 editing-toolbar：`pnpm run build` → rollup 3.1s 产出 1.7 MB bundle 到它自己的测试库）。
3. 无本地 esbuild 也无可用脚本 → 不强行构建，返回「先 `pnpm install`」的明确指引。

**外部化清单必须包含 Node 内置模块**（`crypto` / `path` / …，两种写法 `crypto` 与 `node:crypto` 都要）。实现时用真实第三方插件验证才发现：float-mark 用 `import { createHash } from "crypto"`，而 `--platform=browser` 下 esbuild 无法解析内置模块，若只外部化 `obsidian`/`electron`/`@codemirror/*`/`@lezer/*` 会直接构建失败。官方模板与真实插件的 esbuild 配置都外部化了 builtins。

**绝不调用项目的 `dev` 脚本**：它是 watch 进程，永不退出（float-mark 的 `esbuild.config.mjs` 在非 production 分支调用 `context.watch()`）。工具调用必须返回，因此降级只走 production 脚本。

**L1 自检项**：

| 检查 | 判定 |
|---|---|
| `main.js` 存在且非空 | fail（附 esbuild 输出） |
| CJS 且有导出（静态扫描 `module.exports` / `exports.x`） | fail（提示 `format: 'cjs'`） |
| 产物中 `require("obsidian")` 存在 | 缺失则 warn——**obsidian 被打进 bundle 会在运行时炸** |
| manifest / versions.json / package.json 版本一致 | warn（提示跑 `validate`） |
| submission 命名规则 | warn |

**措辞纪律**：返回值固定声明「static scans of the bundle, not a load test」，**不得**让静态扫描听起来像加载验证；`production` 参数在走项目自带 esbuild 时只是「上报口径」而非产物保证（实际输出由项目自己的 config 决定）。

**不做**：不接管常驻 watch（交给用户或 DSH 后台任务）；产物 `main.js` 本就在模板 `.gitignore` 中，不污染仓库。

### 4.2 `obsidian_plugin_deploy`

**注意其双重角色（P2c 之后）**：`deploy` 的写入动作同时服务两档——

- **L4 沙箱实例**：把产物写进**沙箱实例自己的库**（沙箱库在工作区内），随后由 `e2e` 在实例内启用并断言；**用户窗口不动**；
- **L3 用户实例**：写进用户的库/TestVault，随后 `vault ensure` + `reload`（**会抢焦点**，须确认）。

默认走 L4 那一支；只有在需要验证用户真实环境时才走 L3。

```
resolve projectDir → 读 manifest 取 id → 解析目标 vault
  → ★ 写入范围门禁校验（§2.10）：目标必须位于工作区内且是测试库，否则拒绝
  → 检查产物齐备（main.js + manifest.json [+ styles.css]）
  → 写 <vault>/.obsidian/plugins/<id>/…                     [沙箱约束]
  → 合并写 <vault>/.obsidian/community-plugins.json（去重、保留他项、\t 缩进）
  → 回写 <projectDir>/dsh.obsidian.json
  → 尝试生效：vault-open（若目标库不在前台）→ plugin:enable → 检测信任弹窗 → plugin:reload
  → 输出三态报告
```

**★ 写入范围门禁（§2.10，硬约束）**：`deploy` 是**唯一把文件写进库**的工具，因此它同时是门禁的第一道关。目标不在工作区内、或不是一个测试库（工作区内的 `TestVault` / `dsh.obsidian.json` 中登记的**工作区内**库）时：

```
Error: refusing to write into "<path>" — it is not a workspace test vault.
  This plugin only modifies test vaults it created inside the session workspace;
  your own vaults are read-only.
Options:
  1) Use the workspace test vault: <workspace>/…/TestVault        ← recommended
  2) Run the verification in an L4 sandboxed instance (its vault is a copy):
     obsidian_plugin_e2e projectDir=… action=run
  3) If you really mean it, re-run with the explicit one-shot authorization
     target=user-vault (a single call; nothing is persisted).
```

**绝不「顺手写用户的库」**：即便用户在用真实库做 L3 验证（例如确认「装到我的库里能用吗」），默认仍然只写工作区测试库；L3 只允许**只读观测**用户的库。

**目标 vault 解析优先级**：显式 `vault` 参数（路径或名字）→ `dsh.obsidian.json` 绑定 → 项目内 `TestVault/` → 报错并给出创建指引（**不擅自建库**）。

**三态报告（不得混淆）**：

```
Deployed feishu-style-editor → TestVault
  files:   written (main.js 66KB · manifest.json · styles.css)
  enabled: yes (community-plugins.json updated; verified by plugin:enable)
  active:  yes (loaded in app: app.plugins.plugins["feishu-style-editor"] present)
  trust:   n/a
Next: obsidian_plugin_inspect action=errors
```

若受限模式开启而用户未信任：

```
  enabled: yes (config written)
  active:  NO — trust confirmation pending
  trust:   awaiting-user — Obsidian 需要你确认「信任仓库作者并启用插件」
           （该操作会关闭【该库】的受限模式；检测锚点 .mod-trust-folder）
```

**沙箱越界**返回结构化诊断（不是 stack trace）：工作区内 TestVault 为推荐路径 / 需更宽沙箱模式 / 手动安装三选一。

### 4.3 `obsidian_plugin_test`（L2 离线冒烟）

**定位纪律**：抽样显示头部插件里**多数没有单测**（§2.8），所以 L2 不是主流验证手段，而是**真机不可用时的最低保障**——挡住「加载即崩溃」。返回值固定标注「离线桩环境，非真机」，不得暗示已验证真实行为。

**加载顺序（已用真实插件探针验证）**：

```
1. 建立宿主环境
   · 项目自带 jsdom（若存在）→ 注入 window/document/navigator/HTMLElement/... 与 globalThis.self
   · 缺失且产物访问 DOM → 明确报「该插件需要 DOM 宿主，请 pnpm add -D jsdom」，不静默失败
2. 安装桩：拦截 require("obsidian") → obsidian-stub
3. 预解析清单：用项目自己的 createRequire 解析 @codemirror/*、@lezer/* 的**真实路径**
   （它们是项目真实依赖，桩化会导致 StateEffect.define is not a function）
4. 加载产物 → 取导出（兼容 module.exports 与 module.exports.default）
5. 实例化 → onload() → 断言 → onunload() → 断言清理 → 输出一行 JSON
```

**探针结论（真实插件，非构造样本）**：用上述顺序离线加载 editing-toolbar 的 rollup 产物（1.7 MB 压缩）成功——`loaded: function`、`extends Plugin: true`、实例可构造。

**断言集**：

| 断言 | 级别 |
|---|---|
| 默认导出是 `Plugin` 子类 | fail |
| `onload()` 不抛 | fail（附原始栈 + 首个 console.error） |
| `onunload()` 不抛，且记账的注册资源被回收 | fail / warn |
| 无未捕获 rejection | fail |
| 至少注册命令 / 视图 / 设置页之一 | warn |
| `manifest.minAppVersion` 可解析 | warn |

**桩（`assets/harness/obsidian-stub.cjs`）**：

- 核心 `Plugin` 基类 + **注册调用记账**（`addCommand` / `addRibbonIcon` / `addStatusBarItem` / `addSettingTab` / `registerView` / `registerEvent` / `registerDomEvent` / `registerInterval` / `registerEditorExtension` / `registerMarkdownPostProcessor` / `loadData` / `saveData`）；
- 伪 App：`vault` / `workspace` / `metadataCache` / `fileManager` / `commands` / `setting`；
- **宿主全局**：`moment` 等 Obsidian 注入的全局（editing-toolbar 实测需要）；
- 未实现 API 显式抛 `Not implemented in the offline stub: <name>`。

**前置与降级**：

- 产物不存在 → 指向 `build`，**不隐式构建**；
- 产物不是 CJS → 报「需项目自身 esbuild 转换」并给出下一步，不崩溃；
- 项目无 jsdom 而产物需要 DOM → 明确报出缺口与安装命令。

**场景扩展**：项目内 `dsh/scenarios/<name>.mjs`，`export default async ({ plugin, app, stub }) => { … }`；包内提供 `scenarios/example.mjs` 作为模板。

### 4.4 `obsidian_plugin_e2e`（L4 沙箱实例，新增）

**为什么需要**：L3 的代价是用户的注意力（§2.9）。用户窗口被反复切走，开发期间无法做别的事。L4 用**独立 Obsidian 实例 + 独立 userData** 把代价从架构上消除：用户窗口始终不动，且实例可反复重启、可并行、可切换 Obsidian 版本。

**与 `obsidian_plugin_test` 的分工**：

| | `test`（L2） | `e2e`（L4） |
|---|---|---|
| 运行环境 | 纯 Node + 桩 | **真实 Obsidian**（独立实例） |
| 覆盖 | 加载/注册/清理等结构事实 | 真实运行时行为、真实渲染、真实事件 |
| 依赖 | 无 | Electron/Obsidian 下载 + WebdriverIO |

**实现方式（骨架 + 模板，不自研框架）**：

1. 生成 wdio 配置与测试骨架，基于社区现成方案 `wdio-obsidian-service`（v3.2.0，其底层 `obsidian-launcher` 定位即 *download and launch sandboxed Obsidian instances*），参考 `wdio-obsidian-service-sample-plugin` 的模板；
2. 生成的脚手架包含：把项目产物装入**沙箱实例的库**、启动实例、断言插件加载、跑项目自带的 `.e2e.ts` 场景；
3. **不把 wdio 依赖打进本插件**——它属于用户项目（`pnpm add -D @wdio/cli wdio-obsidian-service`），本插件只负责生成与说明；
4. **降级**：无法下载 Obsidian/Electron（离线环境）→ 报出原因并回退到 L3（需用户确认且告知会抢焦点）或 L1+L2。

**验收意义**：L4 是 P2 之后**消除用户干扰**的关键一环，也是唯一能验证「多 Obsidian 版本兼容性」的档位（对 `minAppVersion` 的声明做实证）。

### 4.5 `obsidian_plugin_vault`（L3 用户实例的前置与清理）

| action | 行为 | 是否需要用户 |
|---|---|---|
| `status` | 列库（`vaults verbose`）+ 判定**当前活动库**（`vault info=name`）+ 受限模式（`plugins:restrict`）+ 是否需首次信任 | 否 |
| `ensure` | 目标库未注册 → 走**首次登记流程**；已注册但不在前台 → `vault-open` 带入前台；受限模式开启 → 返回 `awaiting-user` 的信任引导 | **首次登记 / 信任需确认** |
| `close` | 回收测试窗口（macOS `osascript` 关窗；失败则给出让用户关闭的提示） | 否 |
| `prune` | 清理 `TestVault` 里的插件产物与 `data.json`（测试残留） | 否 |

**首次登记流程（已实测可用，替代原来的「请用户手动 Open folder as vault」）**：

1. 工作区内建目录（可选写入 `README.md`）——**不预置 `.obsidian`**，让 App 自己初始化；
2. **弹窗确认**（DSH client 弹窗）：展示目标绝对路径与后果清单——
   「将在 Obsidian 中把该文件夹登记为库（vault）并打开窗口；**Obsidian 会切到前台**；若这是首次打开带插件的库，可能还会出现一次信任确认」；
3. 确认后执行 `eval code='electron.ipcRenderer.sendSync("vault-open","<path>",false)'`（实测返回 `true`，`obsidian.json` 随之出现新条目，`.obsidian/` 被 App 自动创建）；
4. **轮询直到登记出现**（`vaults` / `obsidian.json`），带上限与超时提示。

**降级链（因为这是未文档化的内部通道）**：

```
vault-open（内部 IPC，已实测）
  ↓ 失败（未来版本可能移除，或 electron/ipcRenderer 不可用）
引导用户手动：Vault switcher → Open folder as vault → 选择 <绝对路径>
  ↓ 仍不可用
真机链整体降级为 L1 + L2，并在结果里标注
```

**绝不做**：不写 `obsidian.json`（vaultId 不可推导，运行中可能被整体回写）；不静默切走用户当前窗口。

### 4.6 `obsidian_plugin_reload`

循环里调用最频繁的状态变更工具。actions：`reload` / `enable` / `disable` / `rescan` / `unrestrict`。

**★ 间接写入门禁（§2.10）**：`enable` / `disable` / `unrestrict` / `rescan` 都会**改写当前活动窗口那个库**（`plugin:enable` 改 `community-plugins.json`；`unrestrict` 改该库受限模式；`rescan` 改运行时索引）。**沙箱对此完全无效**（写盘的是 Obsidian 进程），因此这三类动作在执行前必须先读活动库身份并确认它就是工作区内测试库；不是则**拒绝执行**：

```
Error: refusing to modify vault "<name>" (<path>) — it is not the workspace test vault.
  plugin:enable / unrestrict operate on whatever vault is in front, so this tool
  only runs them against a workspace test vault.
Options: bring the workspace test vault forward, or run the verification in an
  L4 sandboxed instance.
```

`reload`（纯重载，不改配置）不在此列，但它依赖目标库在前台——**不得为此而 `vault-open` 用户的库**（§2.9）。

- 前置：**目标库必须是当前活动窗口**（`plugin:*` 按活动窗口解析）→ 由 `vault ensure` 保证；工具自身在活动库不符时给出指向 `ensure` 的诊断（实测有效）；
- **重试策略**：单次超时（默认 20s）后重试 1 次；
- **调试器冲突**：附加状态下（刚读过 console）`plugin:reload` 会挂死，工具据此判定并提示先 detach；
- **`rescan`（P1 实测新增，必需）**：**Obsidian 只在库加载时扫描一次插件目录**，所以刚部署的插件对 `plugin:*` 完全是不可见的——实测报 `Plugin "x" not found`，而 `app.plugins.loadManifests()` 能在运行时重扫（实测重扫后 `manifests` 从 0 变 1）。因此 `reload` 默认先 rescan，另提供显式 `rescan` action；
- **`unrestrict`**：库处于受限模式时，即便 rescan 成功、清单里有该插件，CLI 仍会报 `Plugin "x" is not enabled` 且**永远不会加载**。此 action 调用 `app.plugins.setEnable(true)`——它是**逐库的安全设置**，会重载窗口，因此必须是显式动作（绝不作为副作用），并在返回里说明影响范围仅该库；
- **启用顺序**：`deploy` 写入 enable 清单 ≠ App 已启用；实测需要 `plugin:enable`（或下次库加载）后才真正加载；
- 返回里区分「命令被接受」与「**加载后校验通过**」：用 `app.plugins.plugins` 判定 loaded，并附 `dev:errors` 的结论。

### 4.7 `obsidian_plugin_inspect`（只读观测，免审）

| action | 命令 | 备注 |
|---|---|---|
| `status`（默认） | `version` + `vault` + `vaults` + `plugins:enabled` + `plugin id=` + `plugins:restrict` | **一次拿全体检事实**；含「目标库是否前台」「是否受限模式」「是否需要信任确认」 |
| `errors` | `dev:errors [clear]` | 无需调试器 |
| `console` | `dev:debug on` → `dev:console` → **`dev:debug off`** | **必须在同一窗口期内 attach→读→detach**；**与 reload 互斥**（附加状态下 reload 必挂，实测复现 2 次）；返回里说明该约束并提示调用方「读完再重启插件」 |
| `dom` | `dev:dom selector=… [text\|attr\|total\|all\|inner]` | 弹窗检测、UI 断言 |
| `css` | `dev:css selector=… [prop=]` | 样式与生效值 |
| `screenshot` | `dev:screenshot path=<workspace 内绝对路径>` | **只截 Obsidian 窗口**；命令可能挂住但文件已写出 → 先查文件存在性，再判定超时 |
| `trustCheck` | `dev:dom selector=".mod-trust-folder" total` | 带重试轮询（弹窗异步渲染） |

**统一约束**：输出限流截断（单条 ≤ 8KB、总 ≤ 32KB）；所有调用带超时 + 重试；空输出判为挂死。

### 4.8 `obsidian_plugin_eval`（高特权，必审）

- `code`：在 App 上下文执行 JS（底层 `obsidian eval code=…`），**返回值回显实际执行的代码**便于审计；
- 常见用法要走 skill 里给的「配方」而不是让模型即兴写（见 §5.2）；
- **审批是唯一一道闸**：`vault-open`（改变窗口布局）与 `setEnable`（改变目标库的受限模式）这类调用必须经用户同意；
- 输出同样截断。

### 4.9 信任弹窗处理（跨工具的横切协议）

```
① 部署/激活前：plugins:restrict 与 trustCheck 体检
   · 受限模式 on → 提前告知会弹窗（而不是等用户看见）
② 检测：.mod-trust-folder（带重试轮询）
   · 命中 → 立即停止后续步骤，返回 awaiting-user + 弹窗语义 + 两个选项
     「① 我去 Obsidian 里点『信任仓库作者并启用插件』 ② 授权我用 eval 为该库关闭受限模式（会重载窗口）」
③ 用户选择后：
   · 选① → 轮询 trustCheck 直到消失，再继续
   · 选② → eval app.plugins.setEnable(true)（**会重载窗口，该调用不会正常返回，属预期**）
          → 等待 App 就绪 → 复检 trustCheck/eval 装载状态
④ 复检：插件实例是否出现、errors 是否干净
```

**红线**：① 永不静默点击「信任」；② 把「已写盘」「已启用」「已加载」三态分开报告；③ 弹窗存在时**不继续执行任何 `plugin:*` / `dev:*` / `eval` 命令**（只会得到无意义输出）；④ `console` 读取与 `reload` **互斥**：读 console 时必须 attach → 读 → 立即 detach，期间禁止 reload（实测附加状态下 reload 必挂）。

### 4.10 环境体检（preflight）与降级矩阵

| 探测 | 方法 | 失败降级 |
|---|---|---|
| CLI 存在 | `which obsidian` → App bundle 路径回退 | L3 不可用；给注册指引（macOS 需管理员弹窗建 `/usr/local/bin/obsidian` 软链） |
| App 运行 | `obsidian version` + 短超时 | 提示「App 未运行」；`ensure` 可显式请求打开（用户可见的 `open -a`） |
| 活动库 | `vault info=name` | 需要前台时先 `vault-open` |
| 受限模式 | `plugins:restrict` | on → 走 §4.9 |
| 信任弹窗 | `dev:dom .mod-trust-folder` | 命中 → awaiting-user |
| vault 注册表 | `obsidian.json`（只读） | 仅支持显式路径 |
| 项目 esbuild | `node_modules/.bin/esbuild` | §4.1 降级档 |
| 平台 | `process.platform` | 路径/关窗分支 |

### 4.11 状态与绑定模型

`<projectDir>/dsh.obsidian.json`（可提交、可手改）：

```json
{
  "version": 1,
  "vault": "/abs/path/to/TestVault",
  "pluginId": "feishu-style-editor",
  "lastDeploy": {
    "at": "2026-09-14T23:01:00Z",
    "files": ["main.js", "manifest.json", "styles.css"],
    "enabled": true,
    "active": true,
    "trust": "not-required"
  }
}
```

- 首次成功 `deploy` 写入；后续 `deploy`/`inspect`/`reload` 省略 `vault` 时读取；
- 其余配置走插件 `Config`：`defaultMinAppVersion`、`obsidianCliTimeoutMs`（默认 20000）、`cliRetries`（默认 1）、`autoReload`；
- **不引入第二个状态文件**。

### 4.12 进程执行底座

| 场景 | 方式 | 理由 |
|---|---|---|
| Obsidian CLI | `spawnSync("obsidian", argv, { timeout, encoding })` | 一次性、同步取输出、可超时；与既有 eslint 调用同构 |
| esbuild | `spawnSync(<project>/node_modules/.bin/esbuild, argv)` | 借用项目自身依赖 |
| 打开 App / 关窗 | `open -a Obsidian`（显式 `ensure`）/ `osascript`（macOS 关窗） | 用户可见、可解释 |
| 未来长任务 | 预留切 `ctx.subprocess` | 当前不做，避免多一个装配失败点 |

### 4.13 开发内循环（写进 skill 的标准动作序列）

**默认走 L4（沙箱实例），用户窗口全程不动**：

```
1. 改 src/**
2. build   projectDir=…                     # L1，快；含入口/产物解析
3. test    projectDir=…                     # L2，秒级，先挡「加载即崩」
4. e2e     projectDir=… action=run          # L4：沙箱实例内安装 + 断言，零干扰
   （首次需 e2e action=init 生成 wdio 脚手架）
5. inspect action=errors / console / dom / css / screenshot   # 对着沙箱实例读，免审
6. eval    code="…"                         # 仅当 inspect 不足以回答时（需审批）
7. validate / version                       # 提交前
```

**需要验证用户的真实环境时才用 L3**（会抢焦点，须显式确认）：

```
deploy vault=<用户库>  →  vault ensure confirm=true  →  reload  →  inspect
```

**分界原则**：默认档必须**不打扰用户**；只有「插件在用户真实库/真实配置下是否正常」这类问题，才值得付出抢焦点的代价。

---

## 5. Skill 与文档更新

### 5.1 `SKILL.md`

- 工具表补全为 **11 个**（含「什么时候用我」的一句话）；
- Workflow 改为 §4.13 的步骤序列，并写明**默认走 L4（沙箱实例，零干扰）**、仅在需要验证用户真实环境时才用 L3；
- 新增**症状 → 动作**决策表：

| 症状 | 先做什么 | 大概率原因 |
|---|---|---|
| 开发时窗口被反复切走 | 改用 L4：`e2e action=run`（沙箱实例） | L3 的 `plugin:*` / `dev:*` 按活动窗口解析，观测前必须带前台 |
| 插件没出现在 Obsidian 里 | `inspect status` | 库选错 / restricted 模式 / 未重启 |
| 装了但功能没生效 | `vault status` → 查信任弹窗 | 首次信任未确认（插件不加载） |
| 部署后 reload 说找不到插件 | `reload action=rescan` | Obsidian 只在库加载时扫描一次插件目录 |
| 改了代码没变化 | `reload` | 未重载，旧 bundle 在内存 |
| `Command "x" not found` / `Plugin "x" not found` | 先带目标库到前台 | `plugin:*` 与 `dev:*` 都只作用于活动窗口的库 |
| 命令无输出且很慢 | 重试一次 | CLI IPC 卡顿（挂死时输出为空） |
| 刚读过 console 后 reload 卡住 | 先 `dev:debug off` | 调试器附加与 reload 冲突 |
| build 报「entry point not found」 | 用 `entry` 参数指定入口 | 真实插件入口有 `src/main.ts` / 根 `main.ts` / `src/plugin/main.ts` 三种 |
| build 后找不到产物 | 看返回里列出的候选位置 | 真实插件可能输出到测试库或 `dir: '.'` |
| UI 不对 | `inspect dom/css/screenshot` | 选择器作用域、CSS 变量、无障碍 |
| `require('obsidian')` 报错 | 检查构建外部化 | obsidian 被打进 bundle |

### 5.2 `reference/` 新增三份

**`reference/obsidian-cli.md`**（逃生舱 + 环境隐知识，**不复制命令目录**，开头一句「完整命令清单以 `obsidian help` 与官方文档为准」）：

- CLI 三原则：需要 App 运行 / 出错也可能 exit 0 / **调用必须包超时**；
- **窗口归属**：`plugin:*` / `dev:*` / `eval` 一律按活动窗口解析，`vault=` 不可靠；先用 `vault-open` 带前台；
- vault 注册表与 `vault-open` 内部通道；
- 信任弹窗语义与其全局影响；
- **本次实测的坑清单**：调试器附加会挂住 reload、弹窗异步渲染、截图可能不返回但文件已写、`dev:console` 需 attach、命令静默超时的重试策略。

**`reference/debugging-playbook.md`**：常用配方（可直接给 `eval` 用）

```js
// 插件是否加载
Object.keys(app.plugins.plugins)
// 插件实例字段与设置（用于校验 onload 副作用）
({keys:Object.keys(app.plugins.plugins["<id>"]||{}), settings:app.plugins.plugins["<id>"]?.settings})
// 已注册命令
Object.keys(app.commands.commands).filter(k=>k.startsWith("<id>"))
// 工作区视图类型
app.workspace.getLeavesOfType("<view-type>").length
// 打开某库（需授权）
electron.ipcRenderer.sendSync("vault-open","<abs path>",false)
```

**`reference/e2e-sandboxed.md`**（L4 接入指引，**不自研框架**）：

- 为什么需要：L3 的 `plugin:*` / `dev:*` 按活动窗口解析，观测前必须把测试库带前台 → **频繁抢焦点**，用户开发期间无法做别的事；
- 方案：`wdio-obsidian-service`（WebdriverIO 服务，底层 `obsidian-launcher` 负责*下载并启动沙箱化 Obsidian 实例*），可多版本、可并行、沙箱隔离以免干扰用户系统；
- 接入路径：以 `wdio-obsidian-service-sample-plugin` 为模板，`pnpm add -D @wdio/cli wdio-obsidian-service`，把项目产物装入沙箱实例的库后跑断言；`obsidian_plugin_e2e action=init` 负责生成这套骨架；
- 边界：依赖不打进本插件；离线环境无法下载 Obsidian/Electron 时，明确回退到 L3（须确认）或 L1+L2。

### 5.3 其它文档（遵守 AGENTS.md 同步约定）

`README.md` / `README.zh.md`（英文为默认语言）、`DEVELOP.md` / `DEVELOP.zh.md`（沉淀 §7 的通用规则）、`README.i18n.yaml`（多语言元数据）、`AGENTS.md`（若新增约定）、`doc/harness.default.md`（能力清单/使用规则）、`doc/manual.zh.txt` / `doc/manual.en.txt`、`doc/version-notes.json`（新增 0.4.0 条目）、`assets/skills/obsidian-plugin/SKILL.md`。

---

## 6. 实现方案

### 6.1 目录结构

P0 已落地的结构（**实际实现**，未按 `infra/ + domain/` 建子目录——同层文件不多时目录嵌套只增加跳转成本）：

```
src/
├── index.ts        # apply()：注册工具 + skill；Config；既有 scaffold/validate/version 与模板、skill 注册
├── fs.ts           # Fs seam：路径双身份（OS 路径 / FsTarget）、sandboxPolicy 传递、workspaceRoot 贯穿
├── proc.ts         # spawnSync 封装：超时、退出码与空输出分类（run/hasExecutable）
├── naming.ts       # 提交命名规则 + 模板占位符渲染 + semver 判定
├── build.ts        # obsidian_plugin_build：入口/产物解析 + 降级档 + L1 静态自检
├── deploy.ts       # obsidian_plugin_deploy：vault 解析、产物安装、enable 列表合并、绑定写入
├── cli.ts          # CLI 调用与结果分类（退出码不可信 / 空输出=挂死 / 重试）
├── inspect.ts      # obsidian_plugin_inspect：观测动作 + 输出截断 + 身份自证
├── vault.ts        # obsidian_plugin_vault：库状态、两段式 ensure、关闭
├── reload.ts       # obsidian_plugin_reload：reload/enable/disable/rescan/unrestrict
└── bundle-doc.ts   # 包内 doc/ 资源读取
test/
├── p0.test.ts      # build/deploy（裸 Node，跑在 lib/ 上）
└── p1.test.ts      # CLI 分类 / eval 解析 / argv 组装 / 截断
assets/
├── templates/      # 与官方 sample-plugin 保持一致
├── harness/        # （P2 新建）harness.cjs + obsidian-stub.cjs + scenarios/
└── skills/obsidian-plugin/   # SKILL.md + reference/{obsidian-cli,debugging-playbook,e2e-sandboxed}.md
```

P2/P3 落地情况：`harness.ts`（`obsidian_plugin_test` 编排）、`e2e.ts`（`obsidian_plugin_e2e` 脚手架）、`test/p2a|p2b|p2c|p3.test.ts` 均已创建；`preflight.ts` 未单独抽出——探测逻辑留在各工具模块内（`cli.ts` 负责分类、`vault.ts` 负责窗口/库探测），继续抽出的收益不足。

**分层原则**：`index.ts` 只做「组合 + 工具声明」，任何可被测试直接调用的逻辑都放在可独立导入的模块里（`test/` 直接从 `lib/` 导入，不经过 Cordis）。

### 6.2 分阶段实施

| 阶段 | 内容 | 交付价值 | 依赖 | 状态 |
|---|---|---|---|---|
| **P0** | `build` + `deploy`（离线路径）+ `dsh.obsidian.json` 绑定 | 「装得进去」，无 CLI 也能用 | 无 | ✅ **已实现**（14 项测试 + 真实第三方插件 float-mark 端到端验证） |
| **P1** | `vault` + `reload` + `inspect`（含受限模式/信任处置） | 「跑得起来、看得见」 | Obsidian + CLI | ✅ **已实现**（29 项测试 + float-mark 真机全链路验收） |
| **P2a（前置）** | `build` 硬化：入口点解析链 + 产物发现链 | 真实插件（rollup/自定义入口/产物落测试库）能被构建与定位 | 无 | ✅ **已实现**（editing-toolbar / obsidian-tasks 实测：`src/plugin/main.ts`、根 `main.ts`、产物落测试库均能解析） |
| **P2b** | `test` + `assets/harness`（L2 离线冒烟） | 无 App 环境下的最低保障：挡住「加载即崩」 | Node | ✅ **已实现**（含视图插件实例化与「环境缺口 vs 插件缺陷」区分；PASS 明确标注为桩环境、不代表 UI 已验证） |
| **P2c** | `e2e`（L4 沙箱实例脚手架）+ `reference/e2e-sandboxed.md` | **消除抢焦点**：默认验证档不再打扰用户 | 能下载 Electron/Obsidian | ✅ **已实现**（真机实测 5 项断言通过、实例窗口 `isVisible()===false`；配置漂移检测随模板演进；库路径解析与 `.gitignore` 见 v0.8.4/0.8.5） |
| **P3** | `eval` + 审批策略 + `preflight` 收敛 + 文档收尾 | 完整闭环与可维护性 | P0–P2 | ✅ **已实现**（`eval` 经审批门禁并在真机验证；`src/` 已分层；六份文档 + skill 随各阶段同步。`preflight.ts` 未抽出，理由见上） |

**阶段边界的理由**：P2a 必须先于 P2b/P2c——入口与产物解析不对，后面两档连「验证对象」都找不到（editing-toolbar 已实测证明）。P2c 优先级高于 P3，因为它解决的是**用户的真实痛点（抢焦点）**，而不是能力补全。

### 6.3 验收标准（含本次已实测项）

| 编号 | 场景 | 期望 | 状态 |
|---|---|---|---|
| A1 | 往 TestVault 部署真实插件 → enable → reload → inspect | enabled/active 均为 yes，`plugin:reload` 返回 `Reloaded`，errors 干净 | ⚠️ **部分验证**：部署/加载/reload/errors 通路可用；`enable` 由 CLI 完成的那一步**目标库未能确证**（时间线显示目标库的 `community-plugins.json` 于两天后才被写入），需一次干净复测 |
| A2 | 首次打开带插件的库 | 检测到 `.mod-trust-folder`，返回 awaiting-user，**不自动点击** | ✅ 弹窗已实测复现、检测锚点可用 |
| A3 | Obsidian 未运行 | build/test 正常；deploy 落盘成功并提示「需打开 App 生效」 | 待验 |
| A4 | vault 在工作区外 | 结构化三选一诊断，无 stack trace | 待验 |
| A5 | 受限模式开启（逐库） | `inspect status` 明确提示该库的受限状态，并提前预警信任弹窗 | ✅ 机制已确认（含 per-vault 存储） |
| A6 | 调试器已附加时调用 reload | 拒绝执行并提示先 detach，不挂死 | ✅ 冲突已复现 |
| A7 | CLI 静默超时 | 重试后成功；连续失败报「App 无响应」+ 恢复指引 | ✅ 现象已复现 |
| A8 | 非模板工程（无 esbuild.config.mjs） | 走 L2 构建脚本或给出明确指引 | 待验 |
| A9 | 文档一致性 | README/DEVELOP/harness/manual/version-notes/SKILL 全部同步 | ✅ 六份文档 + skill 均随各阶段同步；`README.i18n.yaml` 记录英中一致性 blob 戳 |
| **A10** | **obsidian-tasks**（根 `main.ts` + `dir: '.'` 产物 + Svelte 构建链 + 177 个既有测试） | `build` 能解析入口与产物；L2 冒烟给出结论；L4 沙箱内加载成功 | ⚠️ **降级为合成验证**：上述三种布局（根 `main.ts`、`outdir: '.'`、rollup `output.dir` 落项目库）已在 `test/p2a.test.ts` 用合成工程逐条覆盖；但本地那份 obsidian-tasks 检出**只有源码树**（无 `manifest.json`/`package.json`/入口），故无法作为真机样本复现。「项目自带构建脚本优先（esbuild-svelte）」与 L4 沙箱内加载则已在真实项目上实测 |
| **A11** | **零干扰验收**：全程只用 L4/L2/L1 完成一次改动→验证 | **用户的 Obsidian 窗口全程不被切换、焦点不被抢**（用切换次数=0 衡量） | ✅ 工具路径已保证：默认循环不含 `vault-open`（唯一会切窗的命令），L4 实例窗口在 spec 运行前 `isVisible()===false`。**注**：L4 实例自身窗口在启动瞬间仍会出现约 1 秒（无任何开关可抑制，见 §8 说明） |
| **A12** | 多版本兼容（L4 独有） | 在 `minAppVersion` 与最新版两个 Obsidian 版本上跑同一套断言 | ⏳ 机制就绪（`E2E_APP_VERSION` / `E2E_INSTALLER_VERSION`，`browserVersion` 默认 `latest`、可用 `earliest` 取 `minAppVersion`），但尚未在同一套件里对两个版本各跑一遍 |
| **A13** | **写入门禁**：`deploy` 指向用户库 | **拒绝写入**，给出「用工作区测试库 / 走 L4 / 一次性显式授权」三条选项；不产生任何用户库写入 | ✅ 沙箱层强制：工作区外的写入被拒（`EPERM`/`FS_SANDBOX_DENIED`），拒绝路径给出结构化选项与工作区边界说明 |
| **A14** | **间接写入门禁**：活动库是用户库时执行 `reload action=enable` | **拒绝执行**并说明「活动窗口是用户库」；用户库的启用列表与受限模式**保持不变** | ❌ **未按设计实现**：`reload` 只返回「是哪个库应答」（`activeWindowVault()`）用于失败上下文，没有「活动库=用户库则拒绝」的前置门禁；用户库之所以未被改动是**沙箱判定最终写入无效**的结果，而非明确拒绝。设计意图尚未落地 |
| **A15** | 全程零切窗 | 一次「改动 → 验证」的完整循环里，用户 Obsidian 的**活动窗口不发生任何变化**（含不得为让命令成功而 `vault-open`） | ✅ 已约定并落实到工具：`vault-open` 只在 `obsidian_plugin_vault action=ensure` 里出现，默认循环（build → test → e2e）完全不含；skill 明确禁止为让命令成功而抬窗口 |

---

## 7. 关键实现要点（实现时沉淀到 DEVELOP.md）

1. **外部 CLI 不得信任退出码**：出错也可能返回 0；判定以输出为准（`^Error:`）。
2. **空输出 ≠ 成功**：必须把「静默超时/挂死」单独归类，否则会把挂死误判为成功。
3. **所有外部调用带超时 + 重试**：CLI 卡顿是常态；连续失败才判环境故障。
4. **活动窗口即目标**：`plugin:*` / `dev:*` / `eval` 全部按活动窗口的库解析，`vault=` 不可靠；任何跨库操作前先 `vault-open`。
5. **观测必须自证身份**：凡读取窗口级数据（DOM、插件实例、日志缓冲），都要在**同一次读数**里返回 `app.vault.getName()`（必要时加 `app.appId`）。仅凭「CLI 报告的活动库」推断目标是本次验证中所有返工的根因。
6. **产物落盘 ≠ 生效**：安装类工具必须区分「已写入 / 已启用 / 已加载」三态。
7. **不替用户做安全决定**：涉及受限模式（信任）等安全开关的动作一律确认，绝不静默执行。
8. **异步 UI 要轮询、不要单次判定**：弹窗/窗口渲染都是异步的（实测 30s 后才命中）。
9. **不可逆或改变用户环境的动作要显式**：打开/关闭窗口、切库、启动 App 都属此类。
10. **观测类工具限流截断**：日志/求值结果必须限额，避免噪声淹没有效上下文。
11. **降级要写进返回值**：每级降级（无 CLI / 无 esbuild / 无前台窗口 / 信任未决 / 沙箱越界）都显式出现在结果里。
12. **未文档化的内部通道要留退路**：`vault-open` 一类内部 IPC 必须配一条人工兜底路径，并允许整链降级。
13. **沙箱只约束自己**：`ctx.fs` 受 policy 约束，spawn 的子进程不受约束——文档必须写明。
14. **状态会被外部缓存，写盘不等于对方看见**：Obsidian 只在库加载时扫描插件目录，部署后的文件对运行时命令完全不可见（实测 `Plugin "x" not found`）。工具必须在「写盘」与「对方可见」之间插入一次显式的重新索引（此处为 `app.plugins.loadManifests()`），并把这一步作为前置条件而不是让调用者去猜。
15. **一次只暴露一层安全开关**：受限模式这类逐库安全设置，必须做成显式动作（写明影响范围与「会重载窗口」的后果），绝不能作为其它操作顺带的副作用。
16. **不打扰用户是默认约束，不是优化项**：只要一条能力需要把用户的窗口带到前台，它就必须有「沙箱实例」这一档替代（独立实例 + 独立 userData + CDP 驱动）。默认路径绝不允许抢焦点。
17. **入口与产物必须从项目配置推断，不能硬编码**：实测真实插件存在 `src/main.ts`、根 `main.ts`、`src/plugin/main.ts` 三种入口，产物也存在项目根、`dir: '.'`、测试库内三种落点。硬编码等于把一部分真实插件直接挡在门外。
18. **写入范围是硬边界，且必须防「间接写入」**：只允许写工作区内的测试库；用户库一律只读。特别地，**CLI 改写的是「当前活动窗口那个库」**（`plugin:enable` 改启用列表、`unrestrict` 改受限模式），沙箱对此完全无效——因此这类命令必须**先验证活动库身份再执行**，而不是假设它就是我们想操作的那个库。
19. **抢焦点是「我们主动调用 `vault-open`」造成的，不是 CLI 的固有行为**：实测 App 级查询（`version` / `vaults` / `vault info=`）不切窗口；作用于非前台库的 `plugin:*` / `dev:*` 只是**失败**，也不会把窗口拉起来。因此默认路径完全可以不含任何切窗动作——这是设计选择，不是受限的妥协。
20. **离线桩的加载顺序是有依赖的**：宿主环境（jsdom/self/宿主全局）→ 安装 `obsidian` 桩 → 用项目自身 require 预解析 `@codemirror/*` 与 `@lezer/*` 的**真实**路径 → 再加载产物。顺序错了会以各种「`x` is not a function」的形式失败（实测：`StateEffect.define`、`moment.locale`、`self is not defined`）。

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 内部 IPC（`vault-open`）在未来版本变更 | 首次登记自动化失效 | 降级链 + 人工兜底（§4.5）；集中在一处实现便于跟随官方 |
| CLI 处于 Early Access，命令面变化 | L3 能力波动 | 能力探测 + 降级；`dev:cdp` 作逃生舱 |
| CLI 挂死/卡顿（本次多次复现） | 工具返回慢或误判 | 超时 + 重试 + 空输出判定；必要时提示重启 App/重注册 |
| 信任弹窗与**每库**受限模式绑定（localStorage `enable-plugin-<appId>`） | 在测试库上的信任不会波及其它库；但弹窗本身会阻塞加载 | 只引导不代点；三态报告；提前预警 |
| **我们主动 `vault-open` 会切走用户窗口、抢焦点** | 开发期间用户无法做别的事（真实反馈） | **默认路径不含任何切窗动作**（§2.9）；L4 沙箱实例成为默认档；L3 只在验证用户真实环境时使用，且必须确认；返回值显式声明「本次切换了前台」 |
| L4 实例自身的窗口在启动瞬间仍会出现约 1 秒 | 反复跑套件时表现为「闪屏」，虽非用户的实例但仍是干扰 | 窗口由 Obsidian 自举时自行创建并显示，**任何启动开关都拦不住**（`--headless`/`--headless=new`/`--hidden` 均实测无效，service 也无可见性选项）；只能从应用内 `hide()`，这是最早的隐藏点。缓解：`e2e:watch` 复用同一实例，把这次启动成本从「每次运行」降到「一次会话」 |
| **CLI 间接改写用户库**（`plugin:enable` / `unrestrict` 作用于活动窗口） | 用户库的插件启用列表 / 受限模式被悄悄改掉，**沙箱无法拦截** | ⚠️ **对策未落地**：设计为「执行前验证活动库身份，不是工作区测试库即拒绝」（§2.10 / A14），实现目前只返回「是哪个库应答」用于失败上下文。用户库当前未被改动，是**沙箱判定最终写入无效**的结果，而不是明确拒绝——须补上前置门禁 |
| 把用户的库当成测试目标 | 用户真实笔记与配置面临风险 | **写入范围门禁**（§2.10 / A13）：只写工作区内 TestVault；用户库只读；例外仅限一次性显式授权 |
| L4 依赖下载 Obsidian/Electron | 离线/受限网络下不可用 | 明确报出原因并回退 L3（须确认）或 L1+L2；不做静默降级 |
| L4 的实例与用户实例版本不一致 | 结论可能与用户环境不符 | 沙箱实例支持**指定版本**（含 `earliest` = 自动取 manifest 的 `minAppVersion`），可在多版本上跑同一套断言（A12）；与用户环境相关的结论仍以 L3 为准 |
| L4 每次启动需下载 Obsidian/Electron（首次约数十 MB） | 首次使用有等待成本 | 首次下载后本地缓存；文档需说明首次开销，并在离线时明确回退而不是静默降级 |
| 离线桩与真实 API 有差异 | 假阳性 | 固定标注「桩环境」；断言只覆盖结构性事实；`@codemirror/*` 等真实依赖不桩化 |
| 桩覆盖不足导致「未实现 API」频发 | 冒烟不可用 | 桩显式抛错并给出 API 名，按真实插件样本迭代补齐；不追求一次覆盖全部 |
| 真实插件入口/产物形态继续分化 | 构建失败 | 入口/产物解析链 + 报错时列出所有尝试过的位置（A10 用 obsidian-tasks 兜底验证） |
| 截图/日志含私有内容 | 隐私 | 只落盘到工作区内；不做自动上传；L4 实例使用独立 userData，不读取用户库 |
| 工具数 3 → 11 | 选择成本 | 描述写「何时用我」；审批分层；skill 决策表 |

---

## 9. 附录

### 9.1 CLI 速查（实现对照）

```bash
# 体检
obsidian version
obsidian vaults verbose
obsidian vault info=name
obsidian plugins:enabled filter=community
obsidian plugin id=<id>
obsidian plugins:restrict

# 装载（按活动窗口解析：先 vault-open 带前台）
obsidian plugin:enable  id=<id> filter=community
obsidian plugin:reload  id=<id>
obsidian plugin:disable id=<id>

# 观测（同样按活动窗口解析）
obsidian dev:errors [clear]
obsidian dev:debug on && obsidian dev:console limit=50 && obsidian dev:debug off
obsidian dev:dom selector=".workspace-leaf" [text|attr=class|total|all|inner]
obsidian dev:css selector=".my-class" [prop=color]
obsidian dev:screenshot path=<workspace>/shot.png
obsidian eval code="Object.keys(app.plugins.plugins)"

# 逃生舱
obsidian dev:cdp method=Page.captureScreenshot params={}
obsidian reload | restart
```

### 9.2 内部通道备忘

```js
// 打开/登记一个库（渲染进程全局 electron 可用）
electron.ipcRenderer.sendSync("vault-open", "<abs path>", false)   // → true
// 关闭【当前库】的受限模式（等价用户点「信任仓库作者并启用插件」，会重载窗口）
app.plugins.setEnable(true)
// 当前库的受限模式状态与目标自证（推荐每次读取都带上）
({vault:app.vault.getName(), appId:app.appId, restricted:!app.plugins.isEnabled()})
// 信任弹窗检测锚点
document.querySelectorAll(".mod-trust-folder").length
```

### 9.3 绑定文件 schema

```jsonc
// <projectDir>/dsh.obsidian.json
{
  "version": 1,
  "vault": "/abs/path/to/vault",
  "pluginId": "my-plugin",
  "lastDeploy": {
    "at": "ISO-8601",
    "files": ["main.js", "manifest.json", "styles.css"],
    "enabled": true,   // community-plugins.json 已更新
    "active": true,    // 已在运行中的 App 内加载
    "trust": "not-required | granted | pending"
  }
}
```

### 9.4 真实插件抽样明细（§2.8 的原始数据）

数据来源：官方索引 `obsidianmd/obsidian-releases/community-plugins.json`（**7722 个插件**），逐仓库读取构建配置、入口、产物落点与测试基建（`HEAD` 分支，只读关键文件）。

| 插件 | 构建器 | 入口 | 产物落点 | 测试基建 |
|---|---|---|---|---|
| dataview | rollup | `src/main.ts` | `test-vault/.obsidian/plugins/dataview` | jest + jsdom（18） |
| Templater | esbuild | `src/main.ts` | `outfile: main.js` | **wdio-obsidian-service** |
| obsidian-tasks | esbuild | **`main.ts`（根）** | `dir: '.'` | jest + jsdom（**177**） |
| kanban | esbuild | `./src/main.ts` | `dir: './'` | 无 |
| calendar | rollup | `src/main.ts` | `file: main.js` | jest（0 个用例） |
| excalidraw | rollup | 非标准写法（`input` 未匹配常规形态） | — | 无 |
| obsidian-git | esbuild | `src/main.ts` | `outfile: main.js` | vitest（5） |
| recent-files | esbuild | **`main.ts`（根）** | `outfile: main.js` | 无 |
| minimal-settings | esbuild | `src/main.ts` | `outfile: main.js` | 无 |
| style-settings | esbuild | — | — | vitest（0） |
| cmdr | esbuild | `src/main.ts` | — | vitest + jsdom（7） |

**分布小结**：esbuild 7 / rollup 3 / 其它 1；入口 3 种形态；产物 3 种落点；测试基建两极分化（多数为 0）。

### 9.5 L4 沙箱实例的技术依据

| 事实 | 来源 |
|---|---|
| `obsidian-launcher` v3.2.0：下载并启动不同版本的 Obsidian、向库安装插件与主题、**启动带独立用户配置目录的沙箱实例** | 其 README 原文 |
| `copy: true` 打开**库副本**（不改原库）；`plugins` 可装本地插件与社区插件；`appVersion: "earliest"` 取 manifest 的 `minAppVersion`；区分 `appVersion` / `installerVersion` | 其 README 原文 |
| 其依赖包含 `@electron/get`（按版本下载）与 `chrome-remote-interface`（CDP 驱动），另有 `classic-level` | npm registry 元数据 |
| `wdio-obsidian-service` v3.2.0 = 该 launcher + WebdriverIO 服务；能力：多版本测试、**沙箱化以免干扰用户系统**、库切换、CI | 仓库 README |
| 接入模板：`wdio-obsidian-service-sample-plugin` | 同上 |
| 社区实际使用者：Templater（`wdio.conf.mts` + `wdio-obsidian-service`） | §9.4 抽样 |

**对 L3 / L4 的分工结论**：

| | L3 用户实例 | L4 沙箱实例 |
|---|---|---|
| 验证对象 | 插件的**真实使用环境**（用户的库、配置、插件共存） | 插件在**真实 Obsidian 运行时**中的行为 |
| 干扰 | **抢焦点、切窗口** | **零干扰**（用户窗口不动） |
| 可重复性 | 差（用户可能随时改状态） | 好（每次干净实例） |
| 多版本 | 只测用户装的版本 | 可测任意版本（含 `minAppVersion` 断言） |
| 默认档 | 否 | **是** |
