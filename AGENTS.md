# AGENTS.md

This file is for AI coding agents working in this repository. Project details live in the referenced docs; this file only lists mandatory conventions.

## Doc index

- Core capabilities, features, install, and usage: see [README.md](README.md) (English, default) / [README.zh.md](README.zh.md) (中文).
- Architecture, directory structure, dev/test commands: see [DEVELOP.md](DEVELOP.md) (English, default) / [DEVELOP.zh.md](DEVELOP.zh.md) (中文).

## Conventions (mandatory)

### Doc sync (on architecture changes)

On any architecture / interface / naming change (adding, removing, or renaming tools; skill structure or decision-table changes; template / directory / dependency changes), **check and sync** the relevant descriptions in the following files, keeping both languages in sync:

- [README.md](README.md) / [README.zh.md](README.zh.md)
- [DEVELOP.md](DEVELOP.md) / [DEVELOP.zh.md](DEVELOP.zh.md)
- [doc/harness.default.md](doc/harness.default.md)
- [doc/manual.zh.txt](doc/manual.zh.txt) / [doc/manual.en.txt](doc/manual.en.txt)
- [doc/version-notes.json](doc/version-notes.json)
- [assets/skills/obsidian-plugin/SKILL.md](assets/skills/obsidian-plugin/SKILL.md)

### Version bumps are released by tag (mandatory)

Every commit that changes the `version` field in [package.json](package.json) must also create and push a matching **annotated** tag in the same push:

```bash
# 1) the version bump, in the same commit as the change it releases
#    package.json version -> 0.6.0, plus a doc/version-notes.json entry for 0.6.0
git commit -am "feat: …"
# 2) the tag, naming the exact commit that carries that version
git tag -a v0.6.0 -m "v0.6.0: <one-line summary>

<what changed and how it was verified>"
git push origin main v0.6.0
```

Why this is mandatory:

- Pushing a `v*` tag is what triggers `.github/workflows/release.yml` — it publishes the package to npm and creates the GitHub Release. A version bump without a tag ships nothing, and the tag can never be reconstructed later, because the release must point at the commit whose `package.json` carries that version.
- The tag name must match the `package.json` version exactly (`v` + version). npm rejects republishing a version, so a tag pointing at the wrong commit cannot be fixed by retagging — it burns that version number.
- Annotated tags are required: they carry the summary of what shipped, which is what the GitHub Release shows.

Related: add the `doc/version-notes.json` entry for the version in the same commit, and keep the other synced docs current (see "Doc sync" above).

**Verify the release actually landed.** A green Release workflow means "uploaded", not "live": publication is asynchronous and the registry can lag the workflow by minutes. Confirm by reading the registry, and keep polling before concluding anything:

```bash
curl -s "https://registry.npmjs.org/@leelee592%2Fdsh-obsidian-plugin" | python3 -c \
  'import sys,json; print(list(json.load(sys.stdin)["versions"]))'   # must list the new version
```

A single early read is not evidence of failure, and a local `pnpm publish` failing for lack of credentials says nothing about CI. Only conclude "the release failed" after the version is still absent well past the workflow's completion, and verify the artifact itself (`npm pack` → check `lib/`, `doc/`, `assets/`) before calling the release done.

### Reusable rules

Lessons learned while implementing tools must be **generalized into reusable rules** (not concrete implementation details), then distilled into the "## Tool Implementation Notes" section of [DEVELOP.md](DEVELOP.md) and synced to [DEVELOP.zh.md](DEVELOP.zh.md).

### Code development

- Follow the reusable rules in "## Tool Implementation Notes" of [DEVELOP.md](DEVELOP.md).
- Follow DeepSeek Harness plugin Cordis conventions: export `name` / `inject` / `apply(ctx, config)`; register tools with `ctx.tools.register(defineTool({...}))`; get services via `ctx.get(...)` (no property access); read/write files via `ctx.fs` (sandboxed).
