# Development Guide

**🌐 English** | [🇨🇳 中文](./DEVELOP.zh.md)

## Goal

Let DeepSeek Harness (DSH) agents reliably scaffold, build, deploy, validate, and version-sync Obsidian plugins, with accompanying development-guideline knowledge (skill).

## Architecture

Two complementary, single-purpose parts:

1. **Knowledge (skill)** — Obsidian plugin development guidelines (naming/submission rules, accessibility, code quality, submission & Scorecard). Derived from [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill), vendored into [assets/skills/obsidian-plugin](assets/skills/obsidian-plugin/SKILL.md) and registered as a runtime skill via `ctx.skills.register` in `apply()` (independent of project root).
2. **Guardrails (tool bundle)** — this repo `@leelee592/dsh-obsidian-plugin` exposes 5 tools with typed schemas:
   - `obsidian_plugin_scaffold` — generate a skeleton from the obsidian-sample-plugin template
   - `obsidian_plugin_build` — bundle src/main.ts into a loadable main.js + static self-checks
   - `obsidian_plugin_deploy` — install the built artifacts into a vault and enable the plugin id
   - `obsidian_plugin_validate` — structural validation + eslint-plugin-obsidianmd checks
   - `obsidian_plugin_version` — sync versions across three files

```
┌────────────────────────────────────────────┐
│ DSH Host (tools / fs / skill / bash)       │
└───────▲──────────────────────────▲─────────┘
        │ tool bundle             │ skill discovery
┌───────┴──────────────────────┐  ┌────────┴───────────────────┐
│ @leelee592/dsh-obsidian-plugin │  │ obsidian-plugin skill       │
│  5 tools, scaffold…version  │  │  SKILL.md + reference/*     │
└─────────────────────────────┘  └─────────────────────────────┘
```

## Directory Structure

```
.
├── package.json          # dsh.bundle manifest + scripts + peerDeps
├── cordis.patch.yml      # insert obsidian-plugin -> @leelee592/dsh-obsidian-plugin
├── tsconfig.json         # tsc -> lib/
├── pnpm-lock.yaml        # pnpm lockfile
├── src/
│   ├── index.ts          # apply(): tool registration, Config, template + skill wiring
│   ├── fs.ts             # fs seam: path/target duality, sandboxPolicy, workspaceRoot
│   ├── proc.ts           # spawnSync wrapper: timeout + outcome classification
│   ├── naming.ts         # submission naming rules, placeholder rendering, semver
│   ├── build.ts          # obsidian_plugin_build: three-tier degradation + static checks
│   ├── deploy.ts         # obsidian_plugin_deploy: vault resolution, artifacts, binding
│   └── bundle-doc.ts     # read bundled doc/ resources
├── test/
│   └── p0.test.ts        # node:test over lib/ (bare Node, no harness needed)
├── scripts/
│   ├── link-dsh-deps.mjs # link $DSH_HOME @deepseek-ai types
│   └── deploy.sh         # build + register tools + dump-config verify
├── assets/
│   ├── templates/        # obsidian-sample-plugin template (14 files, placeholders)
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
- **Skill distribution**: ship skills under `assets/skills/` as package assets, and register them as runtime skills in `apply()` via `ctx.get("skills")?.register({...})` (body read from `new URL('../assets/skills/<name>/SKILL.md', import.meta.url)`).
- **Two path identities, never mixed**: the backend's `FsTarget` is an opaque key for reads and sandboxed writes; the absolute OS path is what subprocesses (esbuild, external CLIs) can open. Passing a handle to a spawn or an OS path to a sandboxed write silently breaks the sandbox fence, so the fs seam must expose both explicitly.
- **`workspaceRoot` belongs in every fs call**: `ctx.fs.resolve(path)` bases relative paths on the host's `process.cwd()`, not on the session workspace, and a bare-Node fallback has no notion of a workspace at all. Anchor every relative path to the session workspace inside the seam.
- **Never spawn a watch command**: any command that can enter a watch/daemon mode (`pnpm run dev`, `esbuild --watch`) may never return. Prefer explicit one-shot arguments over the project's script, fall back to the project's *production* script only, and always enforce a hard timeout.
- **Classify subprocess outcomes, don't trust exit status**: non-zero exit, missing executable, timeout, and "succeeded but printed nothing" are four different things with four different recoveries. Encode them in the runner's return value instead of inferring from `status`.
- **Static analysis must not read as verification**: when a check only scans an artifact rather than running it, say so in the output. A bundle that was built successfully has not been loaded, and installed files are not a working plugin.
- **Distinguish installed / enabled / active**: installation tools report every state separately and report unverifiable states as `unknown` rather than optimistically. Never let a user (or a model) infer "it works" from "the files are there".
- **Resolve targets deterministically, then fail with options**: explicit argument → remembered binding → documented convention directory → refuse and list the choices. Do not create a target the user did not ask for, and do not guess among candidates.
- **Tool `parameters` are a property map**: `{ name: { type, required?, description } }`, not a JSON Schema root. A JSON Schema root throws inside the tool API at load time and takes the whole plugin down — pin it with a test that registers every tool through the real validator.
- **Report leftovers**: after installing files, list unexpected files in the target directory. A stale artifact from an earlier layout is a failure mode that only surfaces at runtime.
