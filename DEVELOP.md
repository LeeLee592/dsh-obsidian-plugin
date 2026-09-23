# Development Guide

**🌐 English** | [🇨🇳 中文](./DEVELOP.zh.md)

## Goal

Let DeepSeek Harness (DSH) agents reliably scaffold, build, deploy, live-verify, validate, and version-sync Obsidian plugins, with accompanying development-guideline knowledge (skill).

## Architecture

Two complementary, single-purpose parts:

1. **Knowledge (skill)** — Obsidian plugin development guidelines (naming/submission rules, accessibility, code quality, submission & Scorecard). Derived from [gapmiss/obsidian-plugin-skill](https://github.com/gapmiss/obsidian-plugin-skill), vendored into [assets/skills/obsidian-plugin](assets/skills/obsidian-plugin/SKILL.md) and registered as a runtime skill in `apply()` via `ctx.get("skills")?.register({...})` — `ctx.get`, never property access (independent of project root).
2. **Guardrails (tool bundle)** — this repo `@leelee592/dsh-obsidian-plugin` exposes 11 tools with typed schemas:
   - `obsidian_plugin_scaffold` — generate a skeleton from the obsidian-sample-plugin template
   - `obsidian_plugin_build` — bundle into a loadable main.js (entry + artifact resolved from the project's own config) + static self-checks
   - `obsidian_plugin_deploy` — install the built artifacts into a vault and enable the plugin id
   - `obsidian_plugin_inspect` — observation of the running app (status / errors / console / dom / css / screenshot / trustCheck); it never writes to your vault or plugins, but console capture attaches a debugger, `clear` empties the app's buffer, and `screenshot` writes an image file
   - `obsidian_plugin_vault` — manage the vault used for live verification (status / ensure / close / prune)
   - `obsidian_plugin_reload` — make a change take effect and verify the plugin actually loaded
   - `obsidian_plugin_test` — offline smoke test: load the built bundle in plain Node against a stubbed Obsidian API
   - `obsidian_plugin_e2e` — scaffold sandboxed end-to-end tests (WebdriverIO + wdio-obsidian-service)
   - `obsidian_plugin_eval` — run JavaScript in the running app (the one high-privilege tool: approval-gated, echoes the executed code, warns when the code touches window focus)
   - `obsidian_plugin_validate` — structural validation + eslint-plugin-obsidianmd checks
   - `obsidian_plugin_version` — sync versions across three files

```
┌────────────────────────────────────────────┐
│ DSH Host (tools / fs / skill / bash)       │
└───────▲──────────────────────────▲─────────┘
        │ tool bundle             │ skill discovery
┌───────┴──────────────────────┐  ┌────────┴───────────────────┐
│ @leelee592/dsh-obsidian-plugin │  │ obsidian-plugin skill       │
│  11 tools, scaffold…version │  │  SKILL.md + reference/*     │
└─────────────────────────────┘  └─────────────────────────────┘
```

## Verification Tiers

Four tiers, cheapest first; the tier in parentheses is what runs it:

| Tier | Means | Interference |
| --- | --- | --- |
| L1 static | artifact existence, module format / export / external checks, manifest↔artifact consistency (in `build`) | none |
| L2 offline smoke | the bundle is loaded in plain Node against a stubbed Obsidian API and the real lifecycle is exercised (`test`), and the report names what it did not cover | none |
| L3 the user's Obsidian | the CLI drives the user's running app: `vault` / `reload` / `inspect` / `eval` | window-scoped: they act on whichever vault is in front and fail otherwise; only `vault action=ensure confirm=true` switches the window and steals focus |
| L4 sandboxed Obsidian | a separate Obsidian with its own config directory and a copy of the vault runs the project's own WebdriverIO specs (`e2e`); the generated config hides the instance's window in a `before` hook before any spec runs | none for the user's Obsidian; the sandbox's own window shows for ~1s at startup, which no launch flag prevents |

Tier rows use short names: `vault` / `reload` / `inspect` / `eval` are the `obsidian_plugin_*` tools of the same name.

Two rules hold at every tier: **writes stay inside the session workspace** — file writes are denied by the sandbox, and the app-side writes it cannot see (`plugin:enable` / `plugin:disable` / `unrestrict`, which rewrite whichever vault is in the active window) are refused by `obsidian_plugin_reload` when the target path is outside the workspace — and **the default path never switches the user's window or steals focus** (the only action that does is `obsidian_plugin_vault action=ensure confirm=true`).

**A passing check is not acceptance.** A successful `build` and a PASS from the offline smoke test prove that the artifact loads against a stub — not that the plugin works, and not that the UI was verified: the stub has no editor. Any change to interface, rendering or interaction must actually be seen, in the sandboxed e2e tier (`e2e`) or against a running app (`inspect action=screenshot`), and the reply must say what was seen. The rule comes from a real session: a pure UI change was reported done with build + test both green and nothing deployed, so the user saw nothing.

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
│   ├── build.ts          # obsidian_plugin_build: entry/artifact resolution + three-tier build + static checks
│   ├── lookup.ts         # entry-point + artifact resolution chains (configs scanned, never evaluated)
│   ├── deploy.ts         # obsidian_plugin_deploy: vault resolution, artifacts, binding
│   ├── inspect.ts        # obsidian_plugin_inspect: read-only status/errors/console/dom/css
│   ├── vault.ts          # obsidian_plugin_vault: registry, activation ladder, confirm gate
│   ├── reload.ts         # obsidian_plugin_reload: reload/enable/rescan/unrestrict + verify
│   ├── harness.ts        # obsidian_plugin_test: offline smoke (L2) over the built bundle
│   ├── e2e.ts            # obsidian_plugin_e2e: sandboxed e2e scaffold (L4)
│   ├── eval.ts           # obsidian_plugin_eval: run JS in the running app (approval-gated)
│   ├── cli.ts            # obsidian CLI runner: timeout + output-based failure classification
│   └── bundle-doc.ts     # read bundled doc/ resources
├── test/
│   ├── p0.test.ts        # node:test over lib/ (bare Node, no harness needed)
│   ├── p1.test.ts        # node:test over lib/: CLI classification, eval parsing, argv, truncation
│   ├── p2a.test.ts       # node:test over lib/: entry/artifact resolution chains
│   ├── p2b.test.ts       # node:test over lib/: offline smoke harness
│   ├── p2c.test.ts       # node:test over lib/: e2e scaffold
│   └── p3.test.ts        # node:test over lib/: eval guardrails
├── scripts/
│   ├── link-dsh-deps.mjs # link $DSH_HOME @deepseek-ai types
│   └── deploy.sh         # build + register tools + dump-config verify
├── assets/
│   ├── templates/        # obsidian-sample-plugin template (14 files, placeholders)
│   ├── harness/          # obsidian stub + scenario loader for the L2 offline smoke test
│   ├── e2e/              # WebdriverIO templates scaffolded by obsidian_plugin_e2e (L4)
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
pnpm test               # build + node --test test/ (the six suites above)
pnpm run deploy         # build + register into profile + dump-config verify
```

`pnpm run deploy` is equivalent to: `pnpm run build` → `dsh plugin --profile web add "$(pwd)"` → `dsh --profile web --dump-config` and verify the output contains `obsidian-plugin`. Default profile is `web`; override with `DSH_PROFILE=<name>` or `pnpm run deploy -- <name>`.

## Tool Implementation Notes

Reusable rules:

- **Path resolution**: relative paths must be resolved via `ctx.fs.resolve(path, { cwd: workspaceRoot })` (anchored to the session workspace), not `process.cwd()`.
- **Sandbox policy**: every write must pass the session `sandboxPolicy` to `ctx.fs.writeText(target, content, intent, signal, policy)`; get the policy via `ctx.get("sandboxPolicy")?.resolve({ session })` (`ctx.get` does not trigger inject checks; never use property access `ctx.sandboxPolicy`).
- **Templates externalized**: don't inline large template strings in tool code; ship templates as package assets (`assets/templates/`) and read them at runtime via `new URL('../assets/templates/<file>', import.meta.url)` + placeholder replacement.
- **Process execution**: when running external commands (e.g. eslint), `spawnSync` against the target project's own `node_modules/.bin`; degrade to a warning when missing instead of failing.
- **Naming/submission guardrails**: id must not contain `obsidian` or end with `plugin`; name must not contain `Obsidian` or end with `Plugin`; description ends with punctuation; ≤250 chars is a validate-only warning (scaffold does not check length), and the skill docs call it a recommendation.
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
- **A read must prove its own target**: for any command whose target depends on external state (which window is focused, which project is selected), return the identity *inside the same reading* — here, `app.vault.getName()` next to the data. Inferring the target from a separate probe is how a reading silently comes from the wrong place.
- **Never trust an exit status over the output**: a CLI that prints `Error: …` and still exits `0` breaks every status-based check. Classify by output, and give "succeeded but printed nothing" its own category, because a silent timeout is not success.
- **State lives outside your process**: another app caches what it read. Writing a file does not make the other side see it. Insert an explicit re-index between "written" and "visible" instead of leaving the caller to discover it.
- **One safety switch at a time**: a per-scope security setting (here, per-vault restricted mode) is never a silent side effect of another operation. Give it its own explicit action that states the consequence and the blast radius.
- **Do the foreground-sensitive steps in one sequence**: if an operation depends on external focus, run everything that needs it back-to-back. A user switching apps between two tool calls can invalidate the first one's setup.
- **Never hardcode a project's layout**: the entry point and the artifact directory are conventions, not facts. Real plugins use `src/main.ts`, a repository-root `main.ts` or `src/plugin/main.ts`, and build into the project root, a test vault, or `dir: '.'`. Resolve both from the project's own configuration (explicit argument → convention → config → `package.json`), and on failure list every location tried so the caller can act instead of guessing.
- **Prefer the project's own build script whenever the project declares a `build` script**: a bundler config can carry plugins (esbuild-svelte, esbuild-sass-plugin) that no command line of ours can reproduce. Use our own flags only when there is no config to honour, or as an explicit opt-out — and warn then that the project's plugins were not applied.
- **Scan configuration, never evaluate it**: reading a bundler config for `outfile` / `outdir` must not execute project code, and a `dev` config would enter watch mode. Parse the text.
- **Label the verification tier instead of blurring it**: a static scan, an offline stub, a sandboxed instance and the user's own app prove different things. Say which tier produced a result and where its confidence ends — a stub environment does not prove runtime behaviour.
- **Delete interference, do not budget it**: when the cost of an operation is the user's attention (a switched window, stolen focus), run it in a separate instance with its own configuration directory and a copy of the data. That removes the cost instead of minimizing it.
- **The sandbox cannot see writes performed by another process**: `plugin:enable` / `unrestrict` rewrite whatever vault the other app has in front, so no file-level policy can catch them. Check the target's identity before running such a command, and keep the writable set to what the sandbox itself created.
- **A scaffold must ship a runnable state, not just files**: a generated artifact that references something (a vault, a directory, a credential path) has to verify that thing exists and create it when it does not, or the very first run fails on something the generator could have known. "Generated" and "works as generated" are the same claim.
- **Ignore a generated directory's contents, never the directory**: a `.gitignore` rule that excludes a directory wholesale (`e2e/vault/`) also excludes the emptiness a fresh clone needs. Ignore `<dir>/*` and un-ignore a marker file instead — otherwise the class of failure you just fixed returns on someone else's machine.
- **Switch off app-level behaviour where the app decides it, not at launch**: an application that creates and shows its own window during bootstrap cannot be hidden by any launch flag, however plausible the flag looks; every candidate must be *measured* and, if they all fail, the earliest in-app hook is the answer. Likewise, a framework's own option surface is worth reading before inventing a workaround: absence of an option is what justifies the workaround.
- **Acceptance is a thing seen, not a check that passed**: a green build and a green stub-based smoke test prove the artifact loads, and nothing more — the stub has no editor, so they cannot prove that a visible change works. When the change is visible (interface, rendering, interaction), the loop is not finished until it has been seen in a running app — the sandboxed e2e tier or a screenshot — and the reply states what was seen.
