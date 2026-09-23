# dsh-obsidian-plugin

**🌐 English** | [🇨🇳 中文](./README.zh.md)

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/leelee592/dsh-obsidian-plugin)
[![dshfind](https://dshfind.com/api/badge/LeeLee592/dsh-obsidian-plugin?lang=en)](https://dshfind.com/plugins/LeeLee592/dsh-obsidian-plugin?ref=badge)

Provides DeepSeek Harness (DSH) agents with Obsidian plugin development capabilities: scaffolding, building, offline smoke testing, deploying, sandboxed end-to-end testing, live verification against the running app (read-only observation, plus an approval-gated escape hatch that runs code inside it), validation, version syncing, plus a development-guidelines skill.

## Features

### skill

- **`obsidian-plugin`** (knowledge, derived from [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)): Obsidian plugin development guidelines (authoring rules, validation & submission) that steer the agent's workflow.

### tools

- **`obsidian_plugin_scaffold`**: generates a compliant plugin skeleton from the official [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) template, with built-in naming/submission checks.
- **`obsidian_plugin_build`**: bundles a plugin project into a loadable `main.js` (CommonJS, `obsidian` externalized) and runs static self-checks (tier L1); resolves the entry point (explicit `entry` → `src/main.ts` → a repository-root `main.ts` → the project's own esbuild/rollup/vite config → `package.json` main) and the artifact location (project root → the config's `outfile`/`outdir`/`file`/`dir` → the project-local vault layout → a bounded search that also probes `<dir>/.obsidian/plugins/<id>/`), listing everything it tried when a lookup fails, and takes `outDir` to pin the artifact directory; degrades through three tiers (the project's own production `build` script — now preferred **whenever a bundler config exists**, because configs carry plugins that cannot be supplied from the command line → direct project-local esbuild, used when there is no config to honour or as an explicit non-production opt-out that warns the project's plugins were not applied → an actionable refusal), never starts a watch process, and reports which tier it used.
- **`obsidian_plugin_deploy`**: installs the built artifacts into `<vault>/.obsidian/plugins/<id>/` and adds the id to that vault's `community-plugins.json` (merged, existing entries preserved), then remembers the vault in `dsh.obsidian.json`; reports `written` / `enabled` / `active` separately (`active` stays `unknown` until a later phase).
- **`obsidian_plugin_inspect`**: read-only observation of the running app — `status` (one-shot health report: live app version, registered vaults, which vault actually answered, that vault's restricted-mode state, whether the target plugin is installed/enabled/version-matched, and whether Obsidian's trust modal is pending), plus `errors` / `console` / `dom` / `css` / `screenshot` / `trustCheck`; it never changes the app.
- **`obsidian_plugin_vault`**: manages the vault used for live verification — `status` (registered vaults, the active window, what activation would take), `ensure` (without `confirm` it only describes the consequences; with `confirm=true` it registers/opens the vault — Obsidian switches to the front — then verifies by asking the app which vault is active, and reports Obsidian's trust modal instead of accepting it), `close` (macOS), `prune` (not implemented yet).
- **`obsidian_plugin_reload`**: makes a code change take effect in the running app — `reload` (default) / `enable` / `disable` / `rescan` (refresh the app's plugin manifest index: Obsidian only scans a vault's plugin directory at vault load, so a freshly deployed plugin is invisible to every plugin command until this runs) / `unrestrict` (turns **off** restricted mode for that vault — a per-vault security setting that reloads the window, so it is an explicit action, never a side effect); after reloading it verifies that the plugin is actually registered and reports what the plugin logged.
- **`obsidian_plugin_test`**: offline smoke test (tier L2) — loads the built bundle in plain Node against a stubbed Obsidian API and exercises the real lifecycle (default export is a `Plugin` subclass, `onload()` runs, registrations happen, `onunload()` cleans up, no unhandled rejections), so it needs no Obsidian installed; resolves the project's own `@codemirror/*` and `@lezer/*` for real and can use the project's own jsdom for DOM-dependent plugins (if jsdom is missing, the report says so and gives the install command); an optional scenario file (`dsh/scenarios/<name>.mjs`, receiving `{ plugin, app, stub }`) extends it. It does **not** verify runtime behaviour: the report always says it is a stub environment, names what it did not cover (e.g. UI code registered as an editor extension when no DOM host is available), and points at e2e / screenshot for real verification.
- **`obsidian_plugin_e2e`**: scaffolds sandboxed end-to-end tests (tier L4) with WebdriverIO + `wdio-obsidian-service`, which launches a separate Obsidian with an isolated config directory and a copy of the vault, so nothing switches your window or steals focus; `init` writes the WebdriverIO setup (`wdio.conf.mts`, `tsconfig.e2e.json` and a starting spec — the scaffold directory is `dir`, default `e2e/`), adds `e2e` / `e2e:watch` scripts and the downloaded-build directories to `.gitignore` (idempotent, keeps hand-edited files unless `force=true`), and `status` reports what exists and the exact install command without writing anything; the runner dependencies stay in your project.
- **`obsidian_plugin_eval`**: runs JavaScript inside the running Obsidian app and returns the result — the live-state escape hatch for reading what the app really holds (plugin instances, workspace, `metadataCache`), driving an interaction, or trying a fix without rebuilding. It is the **only high-privilege tool** (it executes code in your app), so it is approval-gated, the executed code is echoed back in the result as an audit trail, and the result warns when the code touches window focus (`electron.remote.getCurrentWindow().focus()` and friends), because that steals your focus; `vault` addresses the CLI and `timeoutMs` (default 30000) covers long expressions. Prefer `obsidian_plugin_inspect` (free, no approval) whenever a read-only action can answer the question.
- **`obsidian_plugin_validate`**: validates manifest required fields, naming rules, `versions.json` mapping, and `package.json` version consistency, and lints code with the official [obsidianmd/eslint-plugin](https://github.com/obsidianmd/eslint-plugin) (eslint-plugin-obsidianmd).
- **`obsidian_plugin_version`**: syncs versions across `manifest.json` / `versions.json` / `package.json`.

### verification

Verification has four tiers; the default development loop is L1 + L2 + L4.

| Tier | Means | Interference |
| --- | --- | --- |
| **L1** static | artifact / module-format / manifest checks inside `obsidian_plugin_build` | none |
| **L2** offline smoke | `obsidian_plugin_test` loads the built bundle in plain Node against a stubbed Obsidian API; no Obsidian needed | none |
| **L3** your Obsidian | `obsidian_plugin_vault` / `obsidian_plugin_reload` / `obsidian_plugin_inspect` / `obsidian_plugin_eval` act on **your** running app, CLI-driven; only for verifying your real environment | switches your window and steals focus |
| **L4** sandboxed Obsidian | `obsidian_plugin_e2e` + the project's own WebdriverIO specs run a separate Obsidian (isolated config, vault copy; the generated config hides that instance's window before any spec runs) | none — the default for the development loop |

**A passing check is not acceptance.** `obsidian_plugin_build` succeeding does not mean the plugin works, and a PASS from `obsidian_plugin_test` does not mean the UI was verified. If a change touches interface, rendering or interaction, it must actually be seen in the sandboxed e2e tier (`obsidian_plugin_e2e`) or against the running app (`obsidian_plugin_inspect action=screenshot`), and the reply should say what was seen.

Only test vaults created inside the session workspace are ever modified; your own vaults are read-only, including CLI-side writes such as `plugin:enable` and `unrestrict`, which rewrite whichever vault is in the active window — the tools refuse to run them against a non-test vault. The default path never switches your window or steals focus.

## Install

```bash
dsh plugin --profile web add @leelee592/dsh-obsidian-plugin
```

## Usage

Tell DSH "create an Obsidian plugin …" and the agent loads the `obsidian-plugin` skill, follows the *Obsidian Plugin Development Guidelines*, and calls `obsidian_plugin_scaffold` / `obsidian_plugin_build` / `obsidian_plugin_test` / `obsidian_plugin_deploy` / `obsidian_plugin_e2e` / `obsidian_plugin_inspect` / `obsidian_plugin_vault` / `obsidian_plugin_reload` / `obsidian_plugin_eval` / `obsidian_plugin_validate` / `obsidian_plugin_version` along the way for scaffolding, building, offline smoke testing, deploying, sandboxed end-to-end testing, live verification, running code in the app, validation, and versioning.

## Docs

- [doc/harness.default.md](doc/harness.default.md) — the plugin's HARNESS session context (positioning / capabilities / usage rules).
- [doc/version-notes.json](doc/version-notes.json) — version history (latest first, zh + en).
- [doc/manual.zh.txt](doc/manual.zh.txt) / [doc/manual.en.txt](doc/manual.en.txt) — user manual.

## Compatibility

| Item | Value |
| --- | --- |
| profile | `web` |
| DeepSeek Harness | tested on 0.1.5-rc |
| peer deps | `@deepseek-ai/cordis` ^4.0.2 · `@deepseek-ai/dsh-tools` ^0.1.5-rc.2 · `@deepseek-ai/schemastery` ^3.18.2 |
| permissions | injects `tools` + `fs` (DSH-sandboxed, no external network calls) |
| Node (dev build) | 20+ |
| License | MIT |
