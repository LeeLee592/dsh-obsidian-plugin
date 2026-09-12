# dsh-obsidian-plugin-develop

给 DeepSeek Harness（DSH）的智能体提供 **Obsidian 插件开发能力**：脚手架、校验、版本同步。

## 组成

- **`@dsh-obsidian/tool`**（本仓库，一个 DSH 组合包 / bundle），注册 3 个工具：
  - `obsidian_scaffold` —— 生成合规插件骨架（`src/main.ts` + `src/settings.ts` 声明式设置 + esbuild/eslint + LICENSE 等 12 个文件），内置命名/提交规则校验。
  - `obsidian_validate` —— 校验 manifest 必填字段、命名与提交规则（id/name/description）、`versions.json` 映射与 `package.json` 版本一致性。
  - `obsidian_version` —— 同步 `manifest.json` / `versions.json` / `package.json` 三处版本。
- **`obsidian` skill**（知识库，通过 git submodule 引入 [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)）：Obsidian API、命名/提交规则、无障碍、社区提交与 Scorecard 指南。**不复制**进本仓库，只以 submodule 引用。

## 文档

- `doc/harness.default.md` —— 插件的 HARNESS 会话上下文（定位 / 能力 / 使用规则）。
- `doc/version-notes.json` —— 历史版本更新说明（最新在上，中英双语），运行时由 `VERSION_NOTES` / `getVersionNotes(lang)` 读取。
- `doc/manual.{zh,en}.txt` —— 使用手册。

## 安装

### skill（知识）

```bash
git submodule update --init
bash scripts/install-skill.sh          # 软链到 ~/.dsh/skills/obsidian（或传项目目录）
```

### 工具插件

```bash
npm install                            # typescript + @types/node
npm run link-dsh-deps                  # 链接 $DSH_HOME/profiles/node_modules/@deepseek-ai 类型
npm run build                          # tsc -> lib/
dsh plugin --profile web add "$(pwd)"  # 链接本 checkout 并追加进 dsh.profile.bundles
dsh --profile web --dump-config        # 验证：出现 "# == @dsh-obsidian/tool" 与 "id: obsidian-dev"
dsh web                                # 重启后模型工具集多出 3 个 obsidian_* 工具
```

## 使用

对 DSH 说「帮我新建一个 Obsidian 插件…」，agent 会加载 `obsidian` skill 获取规范，并用 `obsidian_scaffold` / `obsidian_validate` / `obsidian_version` 完成脚手架、校验与版本管理。

配置项 `defaultMinAppVersion`（默认 `1.13.0`）可在 profile 的 `cordis.patch.yml` 按 id 覆盖：

```yaml
- id: obsidian-dev
  config:
    defaultMinAppVersion: '1.14.0'
```

详见 [DESIGN.md](DESIGN.md)。
