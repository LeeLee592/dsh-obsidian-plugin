# dsh-obsidian-plugin

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/LeeLee592/dsh-obsidian-plugin)

给 DeepSeek Harness（DSH）的智能体提供 **Obsidian 插件开发能力**：脚手架、校验、版本同步。

## 功能

安装后，DSH 智能体新增 3 个工具，用于可靠地开发 Obsidian 插件：

- `obsidian_scaffold` —— 生成合规插件骨架（`src/main.ts` + `src/settings.ts` 声明式设置 + esbuild/eslint + LICENSE 等 12 个文件），内置命名/提交规则校验。
- `obsidian_validate` —— 校验 manifest 必填字段、命名与提交规则（id/name/description）、`versions.json` 映射与 `package.json` 版本一致性。
- `obsidian_version` —— 同步 `manifest.json` / `versions.json` / `package.json` 三处版本。

另配套 `obsidian` skill（知识库，经 git submodule 引入 [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)）：Obsidian API、命名/提交规则、无障碍、社区提交与 Scorecard 指南。

## 安装

```bash
dsh plugin --profile web add dsh-obsidian-plugin
```

从源码开发 / 未发布到 registry 时：

```bash
git clone https://github.com/LeeLee592/dsh-obsidian-plugin.git && cd dsh-obsidian-plugin
pnpm install
pnpm run deploy
```

`pnpm run deploy` 依次执行：`tsc -> lib/`、`dsh plugin --profile web add "$(pwd)"`、`dsh --profile web --dump-config` 并校验输出包含 `dsh-obsidian-plugin`。默认 profile 为 `web`，可用 `DSH_PROFILE=<name> pnpm run deploy` 或 `pnpm run deploy -- <name>` 覆盖。

重启以加载工具：

```bash
dsh web
```

## 使用

对 DSH 说「帮我新建一个 Obsidian 插件…」，agent 会加载 `obsidian` skill 获取规范，并用 `obsidian_scaffold` / `obsidian_validate` / `obsidian_version` 完成脚手架、校验与版本管理。

配置项 `defaultMinAppVersion`（默认 `1.13.0`）可在 profile 的 `cordis.patch.yml` 按 id 覆盖：

```yaml
- id: dsh-obsidian-plugin
  config:
    defaultMinAppVersion: '1.14.0'
```

## 权限与风险

- 注入 `["tools", "fs"]`：通过 `ctx.fs` 读写文件系统（受 DSH 沙箱约束），用于脚手架 / 校验 / 版本同步。
- 无外部网络调用，工具本身不访问任何远程服务。
- peer 依赖（`@deepseek-ai/cordis` / `dsh-tools` / `schemastery`）由 DSH 安装目录解析，不随包分发。

## 兼容性

| 项 | 值 |
| --- | --- |
| profile | `web` |
| DeepSeek Harness | 0.1.5-rc 实测 |
| peer deps | `@deepseek-ai/cordis` ^4.0.2 · `@deepseek-ai/dsh-tools` ^0.1.5-rc.2 · `@deepseek-ai/schemastery` ^3.18.2 |
| Node（开发构建） | 20+ |
| License | MIT |

## 真实输出

`pnpm run deploy`：

```text
==> build (tsc -> lib/)
==> register checkout into profile 'web'
+ dsh-obsidian-plugin link:.../dsh-obsidian-plugin
==> verify: dump-config should contain 'dsh-obsidian-plugin'
deploy: OK — 'dsh-obsidian-plugin' registered in profile 'web'
```

`obsidian_scaffold`：

```text
Scaffolded my-plugin into /path/to/my-plugin (12 files). Next: cd my-plugin && pnpm install && pnpm run dev
```

## 文档

- `doc/harness.default.md` —— 插件的 HARNESS 会话上下文（定位 / 能力 / 使用规则）。
- `doc/version-notes.json` —— 历史版本更新说明（最新在上，中英双语）。
- `doc/manual.{zh,en}.txt` —— 使用手册。

详见 [DESIGN.md](DESIGN.md)。
