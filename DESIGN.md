# DESIGN · 打通 Obsidian 插件开发的完整流程

> 面向对象：本仓库维护者与实现者。
> **本文档中所有「已实测」条目均在 macOS 15.7.9 + Obsidian 1.13.7（installer 1.13.7）上跑通并记录；「待验证」条目明确标注。**
> 现状一句话：本插件目前覆盖「生成骨架 → 写代码 → 静态校验 → 改版本」，缺「装进 Obsidian → 跑起来 → 看现象 → 定位问题」这后半程。

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
| 目标库不在前台 → `Command/Plugin "x" not found` | 命令面按**活动窗口**解析 | 先 `vault-open` 把目标库带到前台，并在同一次读数里自证身份（见 §7.5） |
| 端口/焦点被抢 | App 自身行为 | 提前告知用户；测试完可关闭窗口 |

### 2.7 复核修订记录（本版相对上一版的更正）

本文档在提交后经过一次专项复核，以下条目被**更正或降级**，实现时以本版为准：

| 原结论 | 更正后 | 依据 |
|---|---|---|
| `plugin:enable` 是 App 级命令，`vault=` 可跨窗口定向 | **全部 `plugin:*` / `dev:*` / `eval` 按活动窗口解析**；`vault=` 对它们不可靠 | 活动库为 `Notes` 时 `plugin:reload` 报 `Plugin "x" not found`；`vault-open` 到目标库后同一命令返回 `Reloaded` |
| 信任弹窗会关闭**全局**受限模式 | 受限模式是**每库 × 每 App 实例**（localStorage `enable-plugin-<appId>`） | app.js 的 `setEnable`/`isEnabled` 实现 + 实盘 localStorage 键 |
| CLI 完成 enable 的跨库操作已实测 | 该输出的**目标库未确证**，降级为「部分验证」 | 目标库 `community-plugins.json` 的 mtime 晚于部署两天 |
| 文档同步清单使用 `README{,.en}.md` 等旧名 | 仓库已改为 `README.md` / `README.zh.md`（英文默认）+ `README.i18n.yaml` | 仓库现行文件 |
| 缺失 | **新增 §7.5「观测必须自证身份」**：读窗口级数据时须在同一次读数里返回 `app.vault.getName()` | 复核中曾误把用户真实库的插件列表当作 TestVault 的数据，根因是仅凭「CLI 报告的活动库」推断目标 |

---

## 3. 总体设计

### 3.1 分层架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│ DSH Host（tools / fs / skill / bash / subprocess）                        │
└──────▲───────────────────────────────────────────────────────────────────┘
       │ 10 个工具
┌──────┴───────────────────────────────────────────────────────────────────┐
│ @leelee592/dsh-obsidian-plugin                                            │
│  【接口层】 scaffold · validate · version            （既有，行为不变）    │
│            build · deploy · test · inspect · eval · reload · vault（新）  │
│  【能力层】 buildRunner │ vaultDeployer │ smokeHarness │ obsidianBridge    │
│  【底座层】 ctx.fs（受沙箱） · spawnSync（CLI/esbuild，不受沙箱）          │
└──────────────────────────────────────────────────────────────────────────┘
       │ 写 .obsidian/plugins/<id>/                 │ CLI（IPC）+ eval（内部通道）
       ▼                                            ▼
┌──────────────────────────────┐        ┌──────────────────────────────────┐
│ TestVault（工作区内，默认目标）│◄──────│ Obsidian App（运行中）            │
│ · .obsidian/plugins/<id>/    │ reload │ · 插件实例/命令/视图              │
│ · .obsidian/community-plugins│        │ · console/errors/DOM/截图         │
└──────────────────────────────┘        └──────────────────────────────────┘
```

### 3.2 约束层级（设计必须按这个顺序退让）

```
① 用户的安全决定（是否信任仓库 / 是否退出受限模式）   ← 永不由 agent 代做
② 用户的工作环境（不擅自切走用户的库/窗口，除非已确认）
③ 可靠性（挂死、时序、窗口归属都要有降级路径）
④ 能力覆盖（尽可能多自动化）                          ← 最后才牺牲
```

### 3.3 三档验证深度

| 档 | 手段 | 覆盖 | 前置 | 工具 |
|---|---|---|---|---|
| **L1 静态** | 产物存在性、CJS/导出/external 检查、manifest↔产物一致性 | 结构错误、忘构建、版本漂移、obsidian 被打包 | 无 | `build` 的返回段 |
| **L2 离线冒烟** | Node 内 `Module._load` 拦截 `obsidian` 桩，真跑 `onload()`/`onunload()` | 加载崩溃、注册缺失、清理泄漏、`minAppVersion` | Node | `test` |
| **L3 真机** | `vault-open` + `plugin:enable` + `plugin:reload` + `dev:*` + `eval` | 真实行为：UI、交互、真实 vault、异步错误 | Obsidian + CLI | `vault` / `reload` / `inspect` / `eval` |

L1/L2 在**任何环境**都能跑；L3 不可用时降级为 L1+L2 并**明确标注结论的可信度边界**。

### 3.4 工具集合（3 → 10）

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

> 合计 10 个。其中 `validate`/`version` 属「发布链」，`build`/`test`/`deploy`/`vault`/`reload` 属「运行链」，`inspect`/`eval` 属「观测链」。

**拆分依据不是动作数量，而是审批粒度**：DSH 的审批挂在工具级（`tools/pre-execute`）。把 `eval` 混进只读工具会让每一次「看一眼日志」都过闸。约定：**能用 `inspect` 回答的，绝不升级到 `eval`**——绝大多数迭代走免审路径。

---

## 4. 工具详细设计

### 4.1 `obsidian_plugin_build`

**职责**：把 `src/main.ts` 打成可加载的 `main.js`，并做 L1 自检。

**三级降级**（逐级在返回值中标注用了哪一级）：

1. 项目有 `node_modules/.bin/esbuild` → 直接调二进制（`--bundle --external:obsidian … --format=cjs --target=es2021 --outfile=main.js`；dev 追加 `--sourcemap=inline`）。不依赖 `pnpm` 是否存在。
2. 无 `esbuild.config.mjs` → 用内置默认参数（外部化 `obsidian`、`electron`、`@codemirror/*`、`@lezer/*`、Node 内置模块）。
3. 无本地 esbuild → 不强行构建，返回「先 `pnpm install`」或「用项目自身的 `build` 脚本」的明确指引。

**L1 自检项**：

| 检查 | 判定 |
|---|---|
| `main.js` 存在且非空 | fail（附 esbuild 输出） |
| CJS 且有导出 | fail（提示 `format: 'cjs'`） |
| 产物中 `require("obsidian")` 存在 | 缺失则 warn——**obsidian 被打进 bundle 会在运行时炸** |
| manifest / versions.json / package.json 版本一致 | fail（提示跑 `validate`） |
| `styles.css` 存在 | 缺失 warn（提交要求） |

**不做**：不接管 `pnpm run dev` 常驻 watch（交给用户或 DSH 后台任务）；产物 `main.js` 本就在模板 `.gitignore` 中，不污染仓库。

### 4.2 `obsidian_plugin_deploy`

```
resolve projectDir → 读 manifest 取 id → 解析目标 vault
  → 检查产物齐备（main.js + manifest.json [+ styles.css]）
  → 写 <vault>/.obsidian/plugins/<id>/…                     [沙箱约束]
  → 合并写 <vault>/.obsidian/community-plugins.json（去重、保留他项、\t 缩进）
  → 回写 <projectDir>/dsh.obsidian.json
  → 尝试生效：vault-open（若目标库不在前台）→ plugin:enable → 检测信任弹窗 → plugin:reload
  → 输出三态报告
```

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

```
node <assets/harness/harness.cjs> <projectDir>/main.js [scenario.mjs]
  · Module._load 拦截 'obsidian' → 内置桩（Plugin / PluginSettingTab / Notice / Modal / Setting / ItemView …）
  · 伪造 App：vault / workspace / metadataCache / fileManager / commands / setting（最小实现）
  · 记录 register* 调用；实例化默认导出类 → onload() → 断言 → onunload() → 断言清理
  · 兜底：产物不是 CJS 时用项目自身 esbuild 转一次（无 esbuild 则该档不可用并说明）
```

**断言集**：默认导出为 `Plugin` 子类 / `onload()` 不抛 / `onunload()` 不抛且资源被回收 / 无未捕获 rejection / 注册了命令·视图·设置页至少其一（否则 warn）/ `manifest.minAppVersion` 可解析。

**场景扩展**：项目可放 `dsh/scenarios/<name>.mjs`（`export default async ({ plugin, app, stub }) => …`），用 `scenario` 参数选中。

**必须标注局限**：返回值固定带一句「离线桩环境，非真机；真机请用 inspect/`——**不得暗示已验证真实行为**。

### 4.4 `obsidian_plugin_vault`（真机链路的前置与清理）

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

### 4.5 `obsidian_plugin_reload`

循环里调用最频繁的状态变更工具：`reload`（`plugin:reload`）/ `enable` / `disable`（`plugin:enable|disable`）。

- 前置：**目标库必须是当前活动窗口**（`plugin:*` 按活动窗口解析）→ 由 `deploy` 或 `vault ensure` 保证；工具自身也应在执行前自检活动库并在不符时先 `vault-open`；
- **重试策略**：单次超时（默认 20s）后重试 1 次；
- **已知冲突**：若检测到调试器已附加（刚读过 console），**先拒绝执行并提示**——实测附加状态下 `plugin:reload` 会挂死；
- 返回里区分「已重载」与「重载后校验通过」。

### 4.6 `obsidian_plugin_inspect`（只读观测，免审）

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

### 4.7 `obsidian_plugin_eval`（高特权，必审）

- `code`：在 App 上下文执行 JS（底层 `obsidian eval code=…`），**返回值回显实际执行的代码**便于审计；
- 常见用法要走 skill 里给的「配方」而不是让模型即兴写（见 §5.2）；
- **审批是唯一一道闸**：`vault-open`（改变窗口布局）与 `setEnable`（改变目标库的受限模式）这类调用必须经用户同意；
- 输出同样截断。

### 4.8 信任弹窗处理（跨工具的横切协议）

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

### 4.9 环境体检（preflight）与降级矩阵

| 探测 | 方法 | 失败降级 |
|---|---|---|
| CLI 存在 | `which obsidian` → App bundle 路径回退 | L3 不可用；给注册指引（macOS 需管理员弹窗建 `/usr/local/bin/obsidian` 软链） |
| App 运行 | `obsidian version` + 短超时 | 提示「App 未运行」；`ensure` 可显式请求打开（用户可见的 `open -a`） |
| 活动库 | `vault info=name` | 需要前台时先 `vault-open` |
| 受限模式 | `plugins:restrict` | on → 走 §4.8 |
| 信任弹窗 | `dev:dom .mod-trust-folder` | 命中 → awaiting-user |
| vault 注册表 | `obsidian.json`（只读） | 仅支持显式路径 |
| 项目 esbuild | `node_modules/.bin/esbuild` | §4.1 三级降级 |
| 平台 | `process.platform` | 路径/关窗分支 |

### 4.10 状态与绑定模型

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

### 4.11 进程执行底座

| 场景 | 方式 | 理由 |
|---|---|---|
| Obsidian CLI | `spawnSync("obsidian", argv, { timeout, encoding })` | 一次性、同步取输出、可超时；与既有 eslint 调用同构 |
| esbuild | `spawnSync(<project>/node_modules/.bin/esbuild, argv)` | 借用项目自身依赖 |
| 打开 App / 关窗 | `open -a Obsidian`（显式 `ensure`）/ `osascript`（macOS 关窗） | 用户可见、可解释 |
| 未来长任务 | 预留切 `ctx.subprocess` | 当前不做，避免多一个装配失败点 |

### 4.12 开发内循环（写进 skill 的标准动作序列）

```
1. 改 src/**
2. build   projectDir=…                     # L1，快
3. test    projectDir=…                     # L2，秒级，先挡低级错误
4. deploy  projectDir=… (vault=…)           # 写盘 + 启用（首次会引导信任）
5. reload  projectDir=…                     # 让改动生效
6. inspect action=errors / console          # 只读，免审
   inspect action=screenshot                # 视觉核对（read_image）
   inspect action=dom / css                 # UI 断言
7. eval    code="…"                         # 仅当 inspect 不足以回答时（需审批）
8. validate / version                       # 提交前
```

---

## 5. Skill 与文档更新

### 5.1 `SKILL.md`

- 工具表补全为 10 个（含「什么时候用我」的一句话）；
- Workflow 改为 §4.12 的 8 步；
- 新增**症状 → 动作**决策表：

| 症状 | 先做什么 | 大概率原因 |
|---|---|---|
| 插件没出现在 Obsidian 里 | `inspect status` | 库选错 / restricted 模式 / 未重启 |
| 装了但功能没生效 | `vault status` → 查信任弹窗 | 首次信任未确认（插件不加载） |
| 改了代码没变化 | `reload` | 未重载，旧 bundle 在内存 |
| `Command "x" not found` / `Plugin "x" not found` | 先带目标库到前台 | `plugin:*` 与 `dev:*` 都只作用于活动窗口的库 |
| 命令无输出且很慢 | 重试一次 | CLI IPC 卡顿（挂死时输出为空） |
| 刚读过 console 后 reload 卡住 | 先 `dev:debug off` | 调试器附加与 reload 冲突 |
| UI 不对 | `inspect dom/css/screenshot` | 选择器作用域、CSS 变量、无障碍 |
| `require('obsidian')` 报错 | 检查构建外部化 | obsidian 被打进 bundle |

### 5.2 `reference/` 新增两份

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

### 5.3 其它文档（遵守 AGENTS.md 同步约定）

`README.md` / `README.zh.md`（英文为默认语言）、`DEVELOP.md` / `DEVELOP.zh.md`（沉淀 §7 的通用规则）、`README.i18n.yaml`（多语言元数据）、`AGENTS.md`（若新增约定）、`doc/harness.default.md`（能力清单/使用规则）、`doc/manual.zh.txt` / `doc/manual.en.txt`、`doc/version-notes.json`（新增 0.4.0 条目）、`assets/skills/obsidian-plugin/SKILL.md`。

---

## 6. 实现方案

### 6.1 目录结构

```
src/
├── index.ts                # apply()：注册 10 个工具 + skill；Config
├── infra/
│   ├── fs.ts               # Fs seam（抽取，含 sandboxPolicy 传递）
│   ├── proc.ts             # spawnSync 封装：超时、重试、三态判定（正常/Error/空输出）
│   └── preflight.ts        # CLI/App/vault/restricted/trust/esbuild 探测（单次调用内缓存）
├── domain/
│   ├── naming.ts           # 既有 namingProblems / render / toClassName
│   ├── build.ts            # esbuild 三级降级 + L1 自检
│   ├── vault.ts            # 注册表读取 + 部署 + community-plugins.json 语义 + vault-open
│   ├── trust.ts            # 信任弹窗检测/引导/复检（横切协议）
│   ├── smoke.ts            # 离线冒烟编排
│   └── probe.ts            # CLI 动作映射与输出规整（含截断）
└── tools/                  # 每个工具的 defineTool 声明
assets/
├── templates/              # 与官方 sample-plugin 保持一致（不塞测试文件）
├── harness/                # harness.cjs + obsidian-stub.cjs + scenarios/example.mjs
└── skills/obsidian-plugin/ # SKILL.md + reference/{obsidian-cli,debugging-playbook}.md
```

`src/index.ts` 现为 434 行且同时承载工具声明/业务/FS seam，新增工具前必须先分层（对外行为不变：既有 3 个工具的参数与返回文案不动）。

### 6.2 分阶段实施

| 阶段 | 内容 | 交付价值 | 依赖 |
|---|---|---|---|
| **P0** | `build` + `deploy`（离线路径）+ `dsh.obsidian.json` 绑定 | 「装得进去」，无 CLI 也能用 | 无 |
| **P1** | preflight + `vault` + `reload` + `inspect`（含信任协议） | 「跑得起来、看得见」 | Obsidian + CLI |
| **P2** | `test` + `assets/harness` | 无 App 环境的冒烟回归 | Node |
| **P3** | `eval` + 审批策略 + skill/文档同步 + `src/` 分层重构 | 完整闭环与可维护性 | P0–P2 |

**P0 与 P1 的边界是刻意的**：先把不依赖 CLI 的部署做扎实，再叠加有 CLI 时的体验增强。

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
| A8 | 非模板工程（无 esbuild.config.mjs） | 默认参数构建成功或给出明确指引 | 待验 |
| A9 | 文档一致性 | README/DEVELOP/harness/manual/version-notes/SKILL 全部同步 | 待做 |

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

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 内部 IPC（`vault-open`）在未来版本变更 | 首次登记自动化失效 | 降级链 + 人工兜底（§4.4）；集中在一处实现便于跟随官方 |
| CLI 处于 Early Access，命令面变化 | L3 能力波动 | 能力探测 + 降级；`dev:cdp` 作逃生舱 |
| CLI 挂死/卡顿（本次多次复现） | 工具返回慢或误判 | 超时 + 重试 + 空输出判定；必要时提示重启 App/重注册 |
| 信任弹窗与**每库**受限模式绑定（localStorage `enable-plugin-<appId>`） | 在测试库上的信任不会波及其它库；但弹窗本身会阻塞加载 | 只引导不代点；三态报告；提前预警 |
| 真机操作会切走用户窗口 | 打扰用户 | 优先测试库；`ensure` 前确认；`close` 回收 |
| 离线桩与真实 API 有差异 | 假阳性 | 固定标注「桩环境」；断言只覆盖结构性事实 |
| 截图/日志含私有内容 | 隐私 | 只落盘到工作区内；不做自动上传 |
| 工具数 3 → 10 | 选择成本 | 描述写「何时用我」；审批分层；skill 决策表 |

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
