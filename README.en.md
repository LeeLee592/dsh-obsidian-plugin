# dsh-obsidian-plugin

[🌐 **English**](./README.en.md) | [🇨🇳 中文](./README.md)

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/LeeLee592/dsh-obsidian-plugin)

Provides DeepSeek Harness (DSH) agents with Obsidian plugin development capabilities: scaffolding, validation, version syncing, plus a development-guidelines skill.

## Features

### skill

- **`obsidian-plugin`** (knowledge, derived from [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill)): Obsidian plugin development guidelines (authoring rules, validation & submission) that steer the agent's workflow.

### tools

- **`obsidian_plugin_scaffold`**: generates a compliant plugin skeleton from the official [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) template, with built-in naming/submission checks.
- **`obsidian_plugin_validate`**: validates manifest required fields, naming rules, `versions.json` mapping, and `package.json` version consistency, and lints code with the official [obsidianmd/eslint-plugin](https://github.com/obsidianmd/eslint-plugin) (eslint-plugin-obsidianmd).
- **`obsidian_plugin_version`**: syncs versions across `manifest.json` / `versions.json` / `package.json`.

## Install

```bash
dsh plugin --profile web add @leelee592/dsh-obsidian-plugin
```

## Usage

Tell DSH "create an Obsidian plugin …" and the agent loads the `obsidian-plugin` skill, follows the *Obsidian Plugin Development Guidelines*, and calls `obsidian_plugin_scaffold` / `obsidian_plugin_validate` / `obsidian_plugin_version` along the way for scaffolding, validation, and versioning.

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
