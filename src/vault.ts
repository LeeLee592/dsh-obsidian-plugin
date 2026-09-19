// obsidian_plugin_vault — find, activate, and clean up the vault used for live
// verification.
//
// The escalation ladder (DESIGN.md §4.4, §4.8) is deliberately explicit:
//
//   status  → read-only: what exists, what is active, what would be needed
//   ensure  → WITHOUT confirm: report what it would do (never touch the app)
//             WITH confirm:    register/open the vault, then verify
//
// Opening a vault switches the user's Obsidian window, and the first open of a
// vault containing plugins raises Obsidian's trust modal, which disables
// restricted mode for that vault. Both are user-visible consequences, so they
// happen only after an explicit confirmation and are never reported as a mere
// file operation.

import { homedir } from "node:os";
import { join } from "node:path";
import { runCli, explainCliFailure, type CliOptions } from "./cli.js";
import { parseEvalJson } from "./inspect.js";
import type { Fs, FsCall } from "./fs.js";

export type VaultAction = "status" | "ensure" | "close" | "prune";

export interface VaultArgs {
  /** Target vault: absolute path, or a vault name registered with Obsidian. */
  vault?: string;
  action?: VaultAction;
  /** Required to actually open/register a vault or clean it up. */
  confirm?: boolean;
  /** For prune: also delete plugin data.json in the test vault. */
  purge?: boolean;
}

interface Registry {
  vaults?: Record<string, { path?: string; open?: boolean }>;
}

/** Where Obsidian keeps its vault registry, per platform. */
export function registryPath(platform: string = process.platform, home: string = homedir()): string | undefined {
  if (platform === "darwin") return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  if (platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "obsidian", "obsidian.json");
  if (platform === "linux") return join(home, ".config", "obsidian", "obsidian.json");
  return undefined;
}

/** Read the registry for discovery only. Never a write target (vaultIds are opaque). */
export async function readRegistry(fs: Fs): Promise<{ vaults: Array<{ id: string; path: string; open: boolean }>; note?: string }> {
  const path = registryPath();
  if (!path) return { vaults: [], note: "unsupported platform for vault discovery" };
  const raw = await fs.readJson(path);
  if (!raw) {
    return { vaults: [], note: `could not read ${path} (sandbox or OS restriction) — falling back to the CLI` };
  }
  const registry = raw as Registry;
  const vaults = Object.entries(registry.vaults ?? {})
    .map(([id, value]) => ({ id, path: String(value?.path ?? ""), open: Boolean(value?.open) }))
    .filter((v) => v.path !== "");
  return { vaults };
}

/** Ask the app which vault is active. */
function activeVault(cli: CliOptions): { name?: string; failure?: string } {
  const result = runCli(["vault", "info=name"], cli);
  if (result.status === "ok") return { name: result.output.trim() };
  return { failure: explainCliFailure(result, "could not determine the active vault") };
}

/** `eval`-based identity probe, so a reading proves its own target. */
function identity(cli: CliOptions): { vault?: string; failure?: string } {
  const result = runCli(["eval", "code=({vault:app.vault.getName()})"], cli);
  if (result.status !== "ok") return { failure: explainCliFailure(result, "could not confirm the active vault from inside the app") };
  const parsed = parseEvalJson(result.output);
  return { vault: parsed?.vault };
}

async function vaultStatus(fs: Fs, args: VaultArgs, call: FsCall, cli: CliOptions): Promise<string> {
  const lines: string[] = [];

  const cliVersion = runCli(["version"], cli);
  const live = cliVersion.status === "ok";
  lines.push(live ? `Obsidian (live): ${cliVersion.output.split("\n")[0]}` : explainCliFailure(cliVersion, "the live app is unavailable"));

  const registry = await readRegistry(fs);
  const discovered = registry.vaults.length
    ? registry.vaults.map((v) => `${v.path}${v.open ? " (open)" : ""}`).join("\n    ")
    : "(none discovered)";
  lines.push(`Registered vaults (registry):\n    ${discovered}`);
  if (registry.note) lines.push(`  ! ${registry.note}`);

  const listed = runCli(["vaults", "verbose"], cli);
  if (listed.status === "ok") lines.push(`Registered vaults (CLI):\n    ${listed.output.replace(/\n/g, "\n    ")}`);

  const active = activeVault(cli);
  lines.push(active.name ? `Active window vault: ${active.name}` : `  ! ${active.failure}`);

  const restrict = runCli(["plugins:restrict"], cli);
  if (restrict.status === "ok") lines.push(`Restricted mode: ${restrict.output}`);

  if (args.vault) {
    const target = await resolveTarget(fs, args, call);
    if (target.path) {
      const exists = await fs.isDirectory(target.path);
      const registered = registry.vaults.some((v) => v.path === target.path);
      lines.push(
        `Target: ${target.path}\n  on disk: ${exists ? "yes" : "no"}\n  registered: ${registered ? "yes" : "no"}\n  frontmost: ${active.name && target.name === active.name ? "yes" : "no"}`,
      );
      if (!exists || !registered) {
        lines.push('  → run action="ensure" to see what activating it would do, then repeat with confirm=true');
      } else if (active.name !== target.name) {
        lines.push('  → window-scoped commands would hit the wrong vault; run action="ensure" confirm=true to bring it forward');
      }
    }
  }
  return lines.join("\n");
}

interface ResolvedTarget {
  /** Absolute path when the input was a path (or a registered name we could map). */
  path?: string;
  /** Name usable with `vault=` / `vault-open`. */
  name?: string;
}

async function resolveTarget(fs: Fs, args: VaultArgs, call: FsCall): Promise<ResolvedTarget> {
  const source = args.vault;
  if (!source) return {};
  if (source.includes("/") || source.includes("\\") || source.startsWith("~")) {
    const abs = await fs.resolve(source, call.workspaceRoot);
    return { path: abs, name: abs.split(/[\\/]/).filter(Boolean).pop() };
  }
  const registry = await readRegistry(fs);
  const match = registry.vaults.find((v) => v.path.split(/[\\/]/).filter(Boolean).pop() === source);
  return { name: source, path: match?.path };
}

async function ensure(fs: Fs, args: VaultArgs, call: FsCall, cli: CliOptions): Promise<string> {
  if (!args.vault) {
    return 'Error: action="ensure" requires vault=<absolute path to the test vault>.';
  }
  const target = await resolveTarget(fs, args, call);
  const path = target.path!;
  const name = target.name!;

  const exists = await fs.isDirectory(path);
  const registry = await readRegistry(fs);
  const registered = registry.vaults.some((v) => v.path === path);
  const active = activeVault(cli);

  if (active.name === name) {
    return `Vault "${name}" is already the active window — window-scoped commands will reach it.`;
  }

  const plan = [
    `Would make vault "${name}" the active Obsidian window.`,
    `  path:       ${path}`,
    `  on disk:    ${exists ? "yes" : "no — it will be created"}`,
    `  registered: ${registered ? "yes" : "no — opening it registers it with Obsidian"}`,
    active.name ? `  currently active: ${active.name} (Obsidian will switch away from it)` : "",
    "Consequences:",
    "  · Obsidian comes to the front and switches vault windows.",
    "  · If this vault contains community plugins and is in restricted mode, Obsidian shows a",
    '    "Do you trust the author of this vault?" modal. Accepting it disables restricted mode FOR THIS VAULT.',
    '  · Nothing is accepted on your behalf: when that modal is detected, the tool stops and reports it.',
  ].filter(Boolean);

  if (!args.confirm) {
    return `${plan.join("\n")}\n\nRe-run with confirm=true to proceed.`;
  }

  if (!exists) {
    // Create the minimal folder Obsidian needs to treat it as a vault. The
    // rest of .obsidian/ is written by the app itself on first open.
    await fs.writeText(join(path, ".obsidian", "app.json"), "{}\n", call.policy, call.signal);
  }

  const opened = runCli(["eval", `code=electron.ipcRenderer.sendSync("vault-open","${path}",false)`], { ...cli, timeoutMs: 30_000 });
  if (opened.status !== "ok") {
    return [
      explainCliFailure(opened, `could not open vault "${name}"`),
      "Manual fallback: in Obsidian use the vault switcher → Open folder as vault → select the path above.",
    ].join("\n");
  }

  // The window renders asynchronously; verify rather than assume.
  const deadline = Date.now() + 30_000;
  let observed: string | undefined;
  while (Date.now() < deadline) {
    const probe = identity(cli);
    observed = probe.vault;
    if (observed === name) break;
    await sleep(2000);
  }

  if (observed !== name) {
    // Live evidence (a real development session) showed exactly this: the IPC
    // call returns true, but the target vault's window stays in the background
    // and keeps rendering nothing — `vault-open` then answers "Vault already
    // exists" instead of switching to it. The agent in that session worked
    // around it by hand with electron.remote.show()/focus(); to save it that
    // guesswork we do the same thing, once, and say plainly what happened.
    const raised = raiseWindow(name, path, cli);
    if (raised.raised) {
      const confirmed = await confirmActive(name, cli);
      if (confirmed) {
        return [
          `Vault "${name}" is now the active window.`,
          "  ! note: its window was already open but in the background, so it had to be brought to the front",
          "    — your focus moved to Obsidian. This is the one action in the tool set that does that.",
          ...(raised.detail ? [`  detail: ${raised.detail}`] : []),
        ].join("\n");
      }
    }
    return [
      `Asked Obsidian to open "${name}" (CLI returned ${opened.output.trim()}) but the app still reports "${observed ?? "unknown"}" as active.`,
      ...(raised.detail ? [`  ! attempt to raise the existing window: ${raised.detail}`] : []),
      "  The vault's window may be open but not rendering. Options:",
      "    · In Obsidian: use the vault switcher and pick this vault",
      "    · Or verify in a sandboxed instance instead (obsidian_plugin_e2e), which needs no window at all",
    ].join("\n");
  }

  const trust = await pollTrust(cli);
  return [
    `Vault "${name}" is now the active window.`,
    trust.present
      ? [
          "  ! trust confirmation is pending — community plugins will NOT load until the user accepts it.",
          "    In Obsidian: click \"Trust author and enable plugins\", or authorize the eval fallback",
          "    (app.plugins.setEnable(true)) — it disables restricted mode for this vault and reloads the window.",
        ].join("\n")
      : "  no trust modal detected",
    `Next: obsidian_plugin_deploy projectDir=… vault="${path}"`,
  ].join("\n");
}

async function pollTrust(cli: CliOptions): Promise<{ present: boolean }> {
  for (let i = 0; i < 5; i++) {
    const result = runCli(["dev:dom", "selector=.mod-trust-folder", "total"], { ...cli, retries: 0 });
    if (result.status === "ok" && Number.parseInt(result.output.trim(), 10) > 0) return { present: true };
    await sleep(1500);
  }
  return { present: false };
}

async function close(fs: Fs, args: VaultArgs, call: FsCall, cli: CliOptions): Promise<string> {
  const target = await resolveTarget(fs, args, call);
  const active = activeVault(cli);
  if (target.name && active.name && target.name !== active.name) {
    return `Vault "${target.name}" is not the active window (active: "${active.name}") — nothing to close.`;
  }
  if (process.platform !== "darwin") {
    return "Closing a vault window automatically is only implemented for macOS. Close the window in Obsidian.";
  }
  const { run } = await import("./proc.js");
  const script = 'tell application "System Events" to tell process "Obsidian" to click button 1 of window 1';
  const result = run({ command: "osascript", args: ["-e", script], timeoutMs: 15_000 });
  if (result.ok) return "Requested the front Obsidian window to close. Verify with obsidian_plugin_vault action=status.";
  return `Could not close the window automatically (${result.output || result.errorMessage}). Close it in Obsidian.`;
}

async function prune(fs: Fs, args: VaultArgs, call: FsCall): Promise<string> {
  if (!args.vault) return 'Error: action="prune" requires vault=<path>.';
  if (!args.confirm) return "Refusing to delete anything without confirm=true. Re-run with confirm=true to remove the test vault's installed plugin artifacts.";
  return "prune is not implemented yet: deleting files needs a confirmed scope (which plugin directories belong to this project). Use obsidian_plugin_deploy to overwrite instead.";
}

export async function vaultAction(fs: Fs, args: VaultArgs, call: FsCall = {}, cli: CliOptions = {}): Promise<string> {
  const action: VaultAction = args.action ?? "status";
  switch (action) {
    case "status":
      return await vaultStatus(fs, args, call, cli);
    case "ensure":
      return await ensure(fs, args, call, cli);
    case "close":
      return await close(fs, args, call, cli);
    case "prune":
      return await prune(fs, args, call);
    default:
      return `Error: unknown action "${action}".`;
  }
}

/** Poll until the app reports `name` as active, or give up. */
async function confirmActive(name: string, cli: CliOptions, attempts = 5): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (identity(cli).vault === name) return true;
    await sleep(1500);
  }
  return false;
}

/**
 * Bring an already-open vault window to the front.
 *
 * Obsidian's `vault-open` IPC switches vaults inside a window, and returns true
 * even when the target window is merely hidden or unfocused — leaving the agent
 * to stare at a vault whose window renders nothing. This uses electron.remote to
 * raise the matching BrowserWindow, which is the only way to recover that state
 * from outside. It moves the user's focus, so callers must report it.
 */
function raiseWindow(name: string, path: string, cli: CliOptions): { raised: boolean; detail?: string } {
  const code = [
    "(() => {",
    '  const remote = require("electron").remote;',
    "  if (!remote) return { raised: false, detail: 'electron.remote unavailable' };",
    `  const wanted = ${JSON.stringify(name)};`,
    `  const wantedPath = ${JSON.stringify(path)};`,
    "  const wins = remote.BrowserWindow.getAllWindows();",
    "  const match = wins.find((w) => {",
    "    const title = (w.getTitle() || '');",
    "    const url = (w.webContents && w.webContents.getURL && w.webContents.getURL()) || '';",
    "    return title.includes(' - ' + wanted + ' - ') || url.includes(wantedPath);",
    "  });",
    "  if (!match) return { raised: false, detail: 'no window for ' + wanted + ' among ' + wins.length };",
    "  if (match.isMinimized && match.isMinimized()) match.restore();",
    "  match.show();",
    "  match.focus();",
    "  if (match.moveTop) match.moveTop();",
    "  return { raised: true, detail: 'raised window: ' + match.getTitle() };",
    "})()",
  ].join("\n");
  const result = runCli(["eval", `code=${code}`], { ...cli, timeoutMs: 25_000 });
  if (result.status !== "ok") return { raised: false, detail: explainCliFailure(result, "could not raise the window") };
  return { raised: /"raised":\s*true/.test(result.output), detail: result.output.trim().split("\n").pop() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
