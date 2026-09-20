# Obsidian CLI: environment knowledge and escape hatch

This is **not** a command catalogue. The authoritative list is `obsidian help`
(the CLI ships with the app) and the official docs at
<https://help.obsidian.md/cli>. This file records what those sources do not
tell you: how the CLI actually behaves in practice, so you can drive it
directly when the `obsidian_plugin_*` tools do not cover a case.

## Three rules that must never be broken

1. **The app must be running.** The CLI talks to the running Obsidian instance
   over IPC. If Obsidian is not running, the first command launches it.
2. **The exit code is not the result.** The CLI prints `Error: …` and still
   exits `0`, so classify by output, never by status.
3. **Wrap every call in a timeout.** The CLI hangs (silently, producing no
   output) often enough that an unbounded call can block forever. A hang prints
   **nothing at all** — treat empty output as a hang, not as success.

## Command scoping: who answers?

| Command family | Resolved against | Consequence |
|---|---|---|
| `plugin`, `plugin:reload`, `plugin:enable`, `plugin:disable`, `plugins`, `plugins:enabled`, `dev:*`, `eval`, `command` | **the active window's vault** | Wrong vault in front ⇒ `Command "x" not found` or `Plugin "x" not found` |
| `version`, `vaults`, `plugins:restrict` | the app | Safe to call from anywhere |

`vault=<name>` does **not** reliably redirect the first family; in practice it
either times out or reports the command as missing when the target vault is not
the frontmost window. Bring the vault to the front instead
(`obsidian_plugin_vault action=ensure confirm=true`).

Before trusting any window-scoped reading, make it prove its own target in the
same call:

```bash
obsidian eval code='app.vault.getName()'
```

## Vaults

- The registry lives in the Obsidian config directory (`obsidian.json` →
  `{vaults:{<id>:{path,ts,open?}}}`). Vault ids are **opaque**, not a hash of
  the path — never hand-write this file.
- Opening (and thereby registering) a folder uses the app's own IPC channel,
  which is exactly what Obsidian's "open another vault" dialog calls:

  ```bash
  obsidian eval code='electron.ipcRenderer.sendSync("vault-open","/abs/path",false)'
  # => true
  ```

  There is no documented alternative: `open -a Obsidian <folder>` fails with
  `-10820`, and `obsidian://open?path=` only locates files inside an
  already-known vault.
- `vault-open` is an undocumented internal channel. If it ever stops working,
  fall back to the UI: vault switcher → **Open folder as vault**.

## Restricted mode and the trust modal

- Restricted mode is stored **per vault**, in `localStorage` under
  `enable-plugin-<appId>`, so trusting one vault does not affect the others.
- Opening a vault that contains community plugins while its restricted mode is
  on raises the modal `Do you trust the author of this vault?`
  (`.mod-trust-folder`). Accepting it runs
  `app.plugins.setEnable(true)`, which **reloads the window**.
- While restricted mode is on, community plugins never load, and plugin
  commands report `Plugin "x" is not enabled` even though the plugin is present.
- The modal renders asynchronously after the window opens, so a single DOM probe
  is not evidence of absence — poll.
- Never accept the modal on the user's behalf without an explicit instruction:
  it is a security setting for that vault.

## Plugin discovery

Obsidian scans `.obsidian/plugins/` **once, when a vault loads**. A plugin that
was just copied into a vault is therefore invisible to every plugin command
until the app re-reads the directory:

```bash
obsidian eval code='app.plugins.loadManifests()'
```

## Wrapping the CLI by hand

Before reaching for bash, check whether `obsidian_plugin_eval` answers the
question — it carries the timeout, the retry and the error classification that a
hand-rolled wrapper has to reimplement. Two sessions analysed for this project
show the cost of not doing that: the agent built its own wrapper and spent a
large share of its calls on plumbing.

If you do need raw commands, note that **macOS ships no `timeout(1)`** (it is GNU
coreutils; `gtimeout` exists only with Homebrew). Two portable forms:

```sh
perl -e 'alarm 20; exec @ARGV' -- obsidian "$@"     # no dependencies
( "$@" & p=$!; sleep 20; kill -9 $p 2>/dev/null )   # pure shell
```

Both must kill the child rather than only stop waiting: a hung CLI keeps its IPC
socket otherwise.

## Known failure modes

| Symptom | Cause | Recovery |
|---|---|---|
| No output, quick return | CLI hung | Retry; if it persists, restart Obsidian |
| `Command "x" not found` | Wrong vault in front, or an older CLI | Bring the right vault forward, or check `obsidian help` |
| `Plugin "x" not found` | Vault never rescanned its plugin directory | `obsidian_plugin_reload action=rescan` |
| `Plugin "x" is not enabled` | Vault is in restricted mode | `obsidian_plugin_reload action=unrestrict`, or accept the trust prompt |
| `plugin:reload` hangs forever | The console-capture debugger is attached | Detach it (`dev:debug off`) and retry |
| `Vault not found.` | `vault=` names a vault Obsidian does not know | Register it by opening the folder once |
| Everything fails after restarting the app | macOS CLI registration can be lost | Re-enable "Command line interface" in Settings → General |

## Never force the window forward

Do not use `electron.remote.getCurrentWindow().show()`, `.focus()`, `moveTop()`,
`BrowserWindow` construction or any similar call to make Obsidian come to the
front. It takes the user's mouse focus away from whatever they were doing, and
because it is invisible in the tool output, the user experiences it as the agent
randomly stealing their screen. A real session did exactly this — forty such
calls — and the agent later diagnosed it itself as "my debugging method, not the
plugin".

The state that tempts you into it: a vault window that is open but hidden,
minimized or unfocused **renders nothing**, so a screenshot comes back blank or
shows an off-screen layout, and it is easy to conclude the window "needs" to be
raised. Two supported ways out instead:

- `obsidian_plugin_vault action=ensure confirm=true` — brings the target vault
  forward deliberately and says in its output that it moved your focus. Only you
  can do this knowingly.
- `obsidian_plugin_e2e` — a sandboxed instance renders normally without any
  window at all, so no focus is involved.

`obsidian_plugin_inspect action=screenshot` reports the window's render state
when it cannot render, so a blank image is explained rather than mysterious.

## The features the tools already wrap

Prefer the tools; they encode the rules above. Reach for raw commands when you
need something the tools do not expose (vault search, tasks, properties, sync
history, publishing, `dev:cdp`, …). The developer commands are worth knowing:

```bash
obsidian dev:errors [clear]
obsidian dev:debug on && obsidian dev:console level=error && obsidian dev:debug off
obsidian dev:dom selector=".workspace-leaf" [text|attr=class|total|all|inner]
obsidian dev:css selector=".my-class" [prop=color]
obsidian dev:screenshot path=<abs path>
obsidian dev:cdp method=Page.captureScreenshot params={}
obsidian reload | restart
```
