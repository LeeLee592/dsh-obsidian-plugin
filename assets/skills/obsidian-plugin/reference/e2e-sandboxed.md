# Sandboxed end-to-end tests (L4)

Live verification through the Obsidian CLI has a cost that is easy to miss until
you feel it: `plugin:*`, `dev:*` and `eval` all resolve against the **active
window**, so checking anything means bringing the test vault to the front. That
switches the user's window and takes their mouse focus — repeatedly, for the
whole session. Working on anything else while the agent develops becomes
impossible.

Note the precise cause: it is not that the CLI switches windows on its own.
`version`, `vaults`, `vault info=` never do, and a window-scoped command aimed
at a background vault simply **fails** (`Command/Plugin "x" not found`) instead
of raising the window. The only switching command is `vault-open` — which is what
*we* call to bring a vault forward. So the fix is to stop needing it.

## The tier

Sandboxed end-to-end tests run a **separate Obsidian** with:

- its own user-configuration directory (restricted mode, vault registry and
  installed plugins are pristine and cannot affect the user's setup);
- a **copy** of the vault (`copy: true`), so tests never write to real notes;
- CDP-driven control, so nothing needs to be in front.

The project gets this by scaffolding `wdio-obsidian-service` — do that with
`obsidian_plugin_e2e action=init`, which writes `e2e/wdio.conf.mts`,
`e2e/tsconfig.e2e.json` and a starting spec, wires `pnpm run e2e`, and keeps the
downloaded builds out of git.

## What it buys you

| | CLI against your Obsidian | Sandboxed e2e |
|---|---|---|
| Your window / focus | switched and stolen | **untouched** |
| Repeatability | your vault state drifts | fresh instance per run |
| Obsidian versions | only the one you have | any version, including `earliest` = the `minAppVersion` your manifest promises |
| Parallel runs | no | yes |
| Placement | none | none |

## What it does not do

- It does not replace the CLI. The CLI is still the fastest way to observe
  **your** environment with **your** plugins and data — use it deliberately, when
  that is the actual question.
- It does not make assertions about a user's specific vault or config.
- It cannot run without downloading Obsidian/Electron once (a few tens of MB);
  offline, fall back to the CLI tier with the focus cost acknowledged, or to the
  offline smoke test.

## Layout

```
e2e/
  wdio.conf.mts      # service config: version, vault copy, plugin install path
  tsconfig.e2e.json  # types for the specs
  specs/example.e2e.ts
```

`e2e/vault/` is created by the service; `.e2e-obsidian/` holds downloaded builds.
Both are gitignored by the scaffold.

## Writing a spec

Specs run inside the sandboxed app, so reach the API the same way you would in
`eval`, but through the driver:

```ts
const loaded = await browser.executeObsidian(
  ({ app }, id) => id in app.plugins.plugins,
  "my-plugin",
);
expect(loaded).toBe(true);
```

Useful patterns:

```ts
// Commands the plugin registered
await browser.executeObsidian(({ app }) =>
  Object.keys(app.commands.commands).filter((id) => id.startsWith("my-plugin")),
);

// Execute a command and check the observable result
await browser.executeObsidianCommand("my-plugin:do-the-thing");

// Drive the UI: the sandbox is a real Obsidian, so DOM assertions are real
await $(".workspace-leaf-content[data-type='my-view']").waitForExist();
```

## Version coverage

`appVersion: "earliest"` resolves to the `minAppVersion` in `manifest.json`,
which is exactly the compatibility claim the manifest makes. Set
`E2E_APP_VERSION` (and optionally `E2E_INSTALLER_VERSION`) to pin or widen the
matrix. Obsidian ships the app bundle and the Electron installer separately, so
the same app version can be tested on different installer versions if that
matters for a bug.
