# Development Guide

[🌐 **English**](./DEVELOP.en.md) | [🇨🇳 中文](./DEVELOP.md)

## Goal

Let DeepSeek Harness (DSH) agents reliably scaffold, validate, and version-sync Obsidian plugins, with accompanying development-guideline knowledge (skill).

## Architecture

Two complementary, single-purpose parts:

1. **Knowledge (skill)** — Obsidian plugin development guidelines (naming/submission rules, accessibility, code quality, submission & Scorecard). Derived from [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill), vendored into [`.agents/skills/obsidian-plugin`](.agents/skills/obsidian-plugin/SKILL.md), auto-discovered via DSH's project-agents root (rank 200).
2. **Guardrails (tool bundle)** — this repo `@leelee/dsh-obsidian-plugin` exposes 3 tools with typed schemas:
   - `obsidian_plugin_scaffold` — generate a skeleton from the obsidian-sample-plugin template
   - `obsidian_plugin_validate` — structural validation + eslint-plugin-obsidianmd checks
   - `obsidian_plugin_version` — sync versions across three files

```
┌────────────────────────────────────────────┐
│ DSH Host (tools / fs / skill / bash)       │
└───────▲──────────────────────────▲─────────┘
        │ tool bundle             │ skill discovery
┌───────┴──────────────────────┐  ┌────────┴───────────────────┐
│ @leelee/dsh-obsidian-plugin │  │ obsidian-plugin skill       │
│  scaffold/validate/version  │  │  SKILL.md + reference/*     │
└─────────────────────────────┘  └─────────────────────────────┘
```

## Directory Structure

```
.
├── package.json          # dsh.bundle manifest + scripts + peerDeps
├── cordis.patch.yml      # insert obsidian-plugin -> @leelee/dsh-obsidian-plugin
├── tsconfig.json         # tsc -> lib/
├── pnpm-lock.yaml        # pnpm lockfile
├── src/
│   ├── index.ts          # tool plugin (3 tools)
│   └── bundle-doc.ts     # read bundled doc/ resources
├── scripts/
│   ├── link-dsh-deps.mjs # link $DSH_HOME @deepseek-ai types
│   └── deploy.sh         # build + register tools + dump-config verify
├── assets/
│   └── templates/        # obsidian-sample-plugin template (14 files, placeholders)
├── .agents/
│   └── skills/obsidian-plugin/  # built-in skill (SKILL.md + reference/)
├── doc/                  # HARNESS context + manuals + version notes
├── lib/                  # build output (gitignored)
└── README.md / DEVELOP.md
```

## Development & Testing

```bash
pnpm install            # install deps (typescript + @types/node + peer types)
pnpm run link-dsh-deps  # link $DSH_HOME/profiles/node_modules/@deepseek-ai types
pnpm run typecheck      # tsc --noEmit
pnpm run build          # tsc -> lib/
pnpm run deploy         # build + register into profile + dump-config verify
```

`pnpm run deploy` is equivalent to: `pnpm run build` → `dsh plugin --profile web add "$(pwd)"` → `dsh --profile web --dump-config` and verify the output contains `obsidian-plugin`. Default profile is `web`; override with `DSH_PROFILE=<name>` or `pnpm run deploy -- <name>`.

## Tool Implementation Notes

Reusable rules:

- **Path resolution**: relative paths must be resolved via `ctx.fs.resolve(path, { cwd: workspaceRoot })` (anchored to the session workspace), not `process.cwd()`.
- **Sandbox policy**: every write must pass the session `sandboxPolicy` to `ctx.fs.writeText(target, content, intent, signal, policy)`; get the policy via `ctx.get("sandboxPolicy")?.resolve({ session })` (`ctx.get` does not trigger inject checks; never use property access `ctx.sandboxPolicy`).
- **Templates externalized**: don't inline large template strings in tool code; ship templates as package assets (`assets/templates/`) and read them at runtime via `new URL('../assets/templates/<file>', import.meta.url)` + placeholder replacement.
- **Process execution**: when running external commands (e.g. eslint), `spawnSync` against the target project's own `node_modules/.bin`; degrade to a warning when missing instead of failing.
- **Naming/submission guardrails**: id must not contain `obsidian` or end with `plugin`; name must not contain `Obsidian` or end with `Plugin`; description ends with punctuation, ≤250 chars — enforced both in scaffold/validate code and in the skill docs.
- **File I/O seam**: `inject: ["tools", "fs"]`; reads/writes go through `ctx.fs` (sandboxed), falling back to `node:fs` when `ctx.fs` is absent (bare-Node testing).
