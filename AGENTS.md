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

### Reusable rules

Lessons learned while implementing tools must be **generalized into reusable rules** (not concrete implementation details), then distilled into the "## Tool Implementation Notes" section of [DEVELOP.md](DEVELOP.md) and synced to [DEVELOP.zh.md](DEVELOP.zh.md).

### Code development

- Follow the reusable rules in "## Tool Implementation Notes" of [DEVELOP.md](DEVELOP.md).
- Follow DeepSeek Harness plugin Cordis conventions: export `name` / `inject` / `apply(ctx, config)`; register tools with `ctx.tools.register(defineTool({...}))`; get services via `ctx.get(...)` (no property access); read/write files via `ctx.fs` (sandboxed).
