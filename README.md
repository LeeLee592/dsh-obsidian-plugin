# dsh-obsidian-plugin

**🌐 English** | [🇨🇳 中文](./README.zh.md)

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/leelee592/dsh-obsidian-plugin)
[![dshfind](https://dshfind.com/api/badge/LeeLee592/dsh-obsidian-plugin?lang=en)](https://dshfind.com/plugins/LeeLee592/dsh-obsidian-plugin?ref=badge)

Provides DeepSeek Harness (DSH) agents with Obsidian plugin development capabilities: scaffolding, building, deploying, live verification against the running app, validation, version syncing, plus a development-guidelines skill.

## Features

### skill

- **`obsidian-plugin`** (knowledge, derived from [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)): Obsidian plugin development guidelines (authoring rules, validation & submission) that steer the agent's workflow.

### tools

- **`obsidian_plugin_scaffold`**: generates a compliant plugin skeleton from the official [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) template, with built-in naming/submission checks.
- **`obsidian_plugin_build`**: bundles a plugin project into a loadable `main.js` (CommonJS, `obsidian` externalized) and runs static self-checks; degrades through three tiers (project-local esbuild → the project's own production `build` script → an actionable refusal), never starts a watch process, and reports which tier it used.
- **`obsidian_plugin_deploy`**: installs the built artifacts into `<vault>/.obsidian/plugins/<id>/` and adds the id to that vault's `community-plugins.json` (merged, existing entries preserved), then remembers the vault in `dsh.obsidian.json`; reports `written` / `enabled` / `active` separately (`active` stays `unknown` until a later phase).
- **`obsidian_plugin_inspect`**: read-only observation of the running app — `status` (one-shot health report: live app version, registered vaults, which vault actually answered, that vault's restricted-mode state, whether the target plugin is installed/enabled/version-matched, and whether Obsidian's trust modal is pending), plus `errors` / `console` / `dom` / `css` / `screenshot` / `trustCheck`; it never changes the app.
- **`obsidian_plugin_vault`**: manages the vault used for live verification — `status` (registered vaults, the active window, what activation would take), `ensure` (without `confirm` it only describes the consequences; with `confirm=true` it registers/opens the vault — Obsidian switches to the front — then verifies by asking the app which vault is active, and reports Obsidian's trust modal instead of accepting it), `close` (macOS), `prune` (not implemented yet).
- **`obsidian_plugin_reload`**: makes a code change take effect in the running app — `reload` (default) / `enable` / `disable` / `rescan` (refresh the app's plugin manifest index: Obsidian only scans a vault's plugin directory at vault load, so a freshly deployed plugin is invisible to every plugin command until this runs) / `unrestrict` (turns **off** restricted mode for that vault — a per-vault security setting that reloads the window, so it is an explicit action, never a side effect); after reloading it verifies that the plugin is actually registered and reports what the plugin logged.
- **`obsidian_plugin_validate`**: validates manifest required fields, naming rules, `versions.json` mapping, and `package.json` version consistency, and lints code with the official [obsidianmd/eslint-plugin](https://github.com/obsidianmd/eslint-plugin) (eslint-plugin-obsidianmd).
- **`obsidian_plugin_version`**: syncs versions across `manifest.json` / `versions.json` / `package.json`.

## Install

```bash
dsh plugin --profile web add @leelee592/dsh-obsidian-plugin
```

## Usage

Tell DSH "create an Obsidian plugin …" and the agent loads the `obsidian-plugin` skill, follows the *Obsidian Plugin Development Guidelines*, and calls `obsidian_plugin_scaffold` / `obsidian_plugin_build` / `obsidian_plugin_deploy` / `obsidian_plugin_inspect` / `obsidian_plugin_vault` / `obsidian_plugin_reload` / `obsidian_plugin_validate` / `obsidian_plugin_version` along the way for scaffolding, building, deploying, live verification, validation, and versioning.

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
