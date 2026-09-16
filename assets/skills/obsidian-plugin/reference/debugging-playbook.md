# Debugging playbook: recipes that work in the live app

Copy-paste snippets for `obsidian_plugin_inspect action=eval` (which is the CLI's
`eval`, running in the app's own context). Each one answers a question that the
DOM or the logs cannot answer as directly.

**Always include the identity check in the same call as the data.** Window-scoped
readings follow the active window, so a reading that does not name its vault can
silently come from the wrong one:

```js
({ vault: app.vault.getName(), appId: app.appId, … })
```

## Is the plugin loaded, and what does it hold?

```js
// Registered plugins in this vault
Object.keys(app.plugins.plugins)

// Manifests on disk (what Obsidian has scanned — not the same list)
Object.keys(app.plugins.manifests)

// One plugin's live instance state and its settings surface
({
  vault: app.vault.getName(),
  keys: Object.keys(app.plugins.plugins["<id>"] || {}),
  settings: app.plugins.plugins["<id>"]?.settings,
})

// Restricted mode for THIS vault (true = plugins will not load)
!app.plugins.isEnabled()
```

## Did the plugin register what it should?

```js
// Commands (by prefix)
Object.keys(app.commands.commands).filter((k) => k.startsWith("<id>"))

// Views / leaves of a custom view type
app.workspace.getLeavesOfType("<view-type>").length

// Ribbon icons contributed by plugins (count, then narrow by tooltip)
[...document.querySelectorAll(".side-dock-ribbon-action")].map((el) => el.getAttribute("aria-label"))
```

## Force the app to re-read the plugin directory

```js
app.plugins.loadManifests()   // then Object.keys(app.plugins.manifests)
```

## Vault switching and identity

```js
// Which vault is this window showing?
app.vault.getName()

// Open/register another vault (switches the user's window — ask first)
electron.ipcRenderer.sendSync("vault-open", "/abs/path", false)

// Leave restricted mode for this vault (reloads the window — ask first)
app.plugins.setEnable(true)
```

## Reading notes through the API instead of the DOM

Prefer the vault API over scraping the rendered view — it is stable and does not
depend on the active editor:

```js
// Note content (works headlessly, no editor needed)
app.vault.cachedRead(app.vault.getAbstractFileByPath("<path>"))

// Note metadata / frontmatter
app.metadataCache.getFileCache(app.vault.getAbstractFileByPath("<path>"))
```

## Interpreting what you get back

- `app.plugins.manifests` counts what Obsidian has **scanned**; `app.plugins.plugins`
  counts what is **running**. They diverge exactly when a deployment needs a rescan
  or the vault is in restricted mode.
- An empty `plugins` object with a non-empty `manifests` object means the plugin
  was found but refused to load — check restricted mode and `dev:errors` before
  touching the plugin's own code.
- If a reading looks impossible (a plugin you never installed, settings you never
  wrote), check `app.vault.getName()`: you are probably looking at another vault's
  window.
