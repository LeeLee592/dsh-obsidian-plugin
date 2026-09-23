// obsidian_plugin_reload — make a code change take effect in the running app.
//
// Two operational facts drive this module (DESIGN.md §4.5, §2.6):
//
//   * `plugin:reload` hangs while the console-capture debugger is attached.
//     Rather than let the call sit until its timeout, a hang is interpreted as
//     "the debugger is probably still attached" and reported that way.
//   * A reload is not verified by the CLI's success line alone. The tool can
//     confirm the plugin is actually registered in the app afterwards, which is
//     the difference between "the command was accepted" and "the plugin loaded".

import { join, resolve, sep } from "node:path";
import { runCli, explainCliFailure, type CliOptions } from "./cli.js";
import { parseEvalJson } from "./inspect.js";

export type ReloadAction = "reload" | "enable" | "disable" | "rescan" | "unrestrict";

export interface ReloadArgs {
  /** Plugin id; read from manifest.json when projectDir is given. */
  pluginId?: string;
  projectDir?: string;
  /** Target vault name (see inspect: window-scoped commands follow the active window). */
  vault?: string;
  action?: ReloadAction;
  /** Confirm the plugin is registered in the app after the command. */
  verify?: boolean;
  /** reload: refresh the plugin manifest index first (default true). */
  rescan?: boolean;
}

export interface ReloadDeps {
  cli?: CliOptions;
  /** Read the plugin id from the project's manifest.json. */
  readManifestId?: (projectDir: string) => Promise<string | undefined>;
  /** Session workspace root; targets outside it are refused (see writeScopeRefusal). */
  workspaceRoot?: string;
}

/**
 * Refuse an app-side write aimed at a vault outside the session workspace.
 *
 * Why this is not the file sandbox: `plugin:enable`, `plugin:disable` and
 * `unrestrict` are executed BY the Obsidian app, which rewrites whichever vault
 * its window currently shows. Those writes never pass through `ctx.fs`, so no
 * file-level policy can see them — the sandbox would deny nothing while the
 * user's enable list or restricted-mode setting changed silently. The only
 * available fence is our own, checked before the command runs.
 *
 * A vault identified only as "whatever the active window shows" cannot be
 * located from here, so that case is not refused; naming a path outside the
 * workspace is.
 */
export function writeScopeRefusal(
  vault: string | undefined,
  workspaceRoot: string | undefined,
): string | undefined {
  if (!vault || !workspaceRoot) return undefined;
  const root = resolve(workspaceRoot);
  const target = resolve(vault);
  if (target === root || target.startsWith(root + sep)) return undefined;
  return [
    `Error: refusing to run an app-side write against "${vault}" — it is outside the session workspace.`,
    "Obsidian performs plugin:enable / plugin:disable / unrestrict itself, so these rewrite whichever",
    "vault its window has in front and the file sandbox cannot intercept them. This tool therefore",
    "refuses any target it can prove is outside the workspace.",
    "Options:",
    `  1) Use a test vault inside the workspace: ${join(workspaceRoot, "TestVault")}   ← recommended`,
    "  2) Verify the change in the sandboxed tier instead: obsidian_plugin_e2e (no app-side writes)",
    "  3) If you really mean your own vault, run that command yourself — this tool will not.",
  ].join("\n");
}

function withVault(vault: string | undefined, argv: string[]): string[] {
  return vault ? [`vault=${vault}`, ...argv] : argv;
}

export async function reloadPlugin(args: ReloadArgs, deps: ReloadDeps = {}): Promise<string> {
  const cli = deps.cli ?? {};
  const action: ReloadAction = args.action ?? "reload";

  // Every action here writes through the app, so the scope check comes first —
  // before any command runs, including rescan/unrestrict which have no plugin id.
  const refusal = writeScopeRefusal(args.vault, deps.workspaceRoot);
  if (refusal) return refusal;

  let pluginId = args.pluginId;
  if (!pluginId && args.projectDir && deps.readManifestId) {
    pluginId = await deps.readManifestId(args.projectDir);
  }

  // `rescan` operates on the vault, not on one plugin, so it is handled before
  // the plugin-id requirement.
  if (action === "rescan") {
    const result = rescanManifests(args.vault, cli, { force: true });
    if (result === undefined) {
      return "Error: could not refresh the plugin manifest index — the eval probe did not return a count.";
    }
    return [
      `Rescanned the vault's plugin directory: ${result.scanned} manifest(s) indexed.`,
      "  Obsidian only scans at vault load, so this is what makes a freshly deployed plugin visible.",
      "Next: obsidian_plugin_reload action=reload projectDir=<project>",
    ].join("\n");
  }

  if (action === "unrestrict") {
    // Disabling restricted mode is a per-vault security setting (localStorage
    // `enable-plugin-<appId>`) and reloads the window, so it is a distinct,
    // explicitly requested action — never a silent side effect.
    const before = restrictionProbe(args.vault, cli);
    if (before === undefined) return "Error: could not read the vault's restricted-mode state.";
    if (before === false) return "This vault is already out of restricted mode; nothing to do.";

    const applied = evalCode(args.vault, "app.plugins.setEnable(true)", cli, 25_000);
    // The window reloads, so the call normally never returns; that is expected.
    const after = await pollUnrestricted(args.vault, cli);
    return [
      after === false
        ? "Restricted mode is now OFF for this vault — community plugins can load."
        : "Requested unrestricted mode for this vault (it reloads the window); could not confirm yet.",
      applied.status === "hang"
        ? "  (the eval call did not return, which is expected: the window reloads)"
        : `  obsidian reported: ${applied.output.trim()}`,
      "This is a security setting for THIS vault only; other vaults keep theirs.",
      `Next: obsidian_plugin_reload action=reload pluginId=<id>`,
    ].join("\n");
  }

  if (!pluginId) return "Error: provide pluginId, or projectDir with a readable manifest.json.";

  if (action === "reload") {
    // Obsidian scans the plugins directory ONCE, when it loads a vault. A plugin
    // that was just deployed is therefore invisible to `plugin:reload` until the
    // manifest index is refreshed — so refresh it as part of every reload unless
    // the caller opts out.
    const rescan = args.rescan === false ? undefined : rescanManifests(args.vault, cli);

    const result = runCli(withVault(args.vault, ["plugin:reload", `id=${pluginId}`]), cli);
    if (result.status === "hang") {
      const attached = debuggerHint();
      return [
        `Reloading "${pluginId}" did not return.`,
        attached
          ? "  ! the console-capture debugger looks attached — plugin:reload hangs while it is (detach with obsidian_plugin_inspect action=console, which detaches on its own, or dev:debug off)"
          : "  ! retried once and still no response — Obsidian may be busy or wedged; try again, then restart it",
        "Not verified: the command's outcome is unknown.",
      ].join("\n");
    }
    if (result.status !== "ok") {
      // Window-scoped commands follow the ACTIVE window, and "not found" almost
      // always means the wrong vault is in front. A real session had to run an
      // extra command to discover that, so report who answered right here.
      const active = activeWindowVault(cli);
      const reported = explainCliFailure(result, `could not reload "${pluginId}"`);
      const context = active
        ? [
            `  addressed window answered from vault: "${active}"${args.vault && args.vault !== active ? ` (asked for "${args.vault}")` : ""}`,
            active === args.vault ? "" : "  Window-scoped commands only reach the vault in front: obsidian_plugin_vault action=ensure confirm=true",
          ].filter(Boolean)
        : [];
      const restricted = restrictionProbe(args.vault, cli);
      if (restricted === true) {
        return [
          reported,
          ...context,
          `  ! this vault is in restricted mode, so the CLI cannot address "${pluginId}" at all.`,
          "    Run the unrestricted activation (a security setting for this vault) or accept Obsidian's trust prompt.",
        ].join("\n");
      }
      return [reported, ...context].join("\n");
    }

    const lines = [`Reloaded ${pluginId} (Obsidian reported: ${result.output.trim()})`];
    if (rescan?.scanned !== undefined) {
      lines.push(
        rescan.scanned > 0
          ? `  manifests rescan: ${rescan.scanned} plugin(s) on disk in this vault`
          : "  manifests rescan: 0 plugins found on disk — is the vault the one you deployed into?",
      );
    }
    if (args.verify !== false) lines.push(...(await verifyLoaded(pluginId, args.vault, cli)));
    return lines.join("\n");
  }



  // enable / disable are app-level commands but still resolve against the
  // active window's vault, hence the same foreground requirement as reload.
  const command = action === "enable" ? "plugin:enable" : "plugin:disable";
  const result = runCli(withVault(args.vault, [command, `id=${pluginId}`, "filter=community"]), cli);
  if (result.status !== "ok") return explainCliFailure(result, `could not ${action} "${pluginId}"`);

  const lines = [`${action === "enable" ? "Enabled" : "Disabled"} ${pluginId} (Obsidian reported: ${result.output.trim()})`];
  if (action === "enable" && args.verify !== false) lines.push(...(await verifyLoaded(pluginId, args.vault, cli)));
  else if (action === "disable") lines.push("Note: disabling writes the vault's enable list; the plugin unloads immediately.");
  return lines.join("\n");
}

/**
 * Confirm the plugin is registered in the app, and surface anything it logged.
 *
 * This is the only honest way to answer "did it actually load?" — the enable
 * list and the file check both answer a weaker question.
 */
async function verifyLoaded(pluginId: string, vault: string | undefined, cli: CliOptions): Promise<string[]> {
  const lines: string[] = [];
  const probe = runCli(
    withVault(vault, ["eval", `code=(${JSON.stringify(pluginId)} in app.plugins.plugins)`]),
    cli,
  );
  if (probe.status === "ok") {
    const loaded = probe.output.includes("true");
    lines.push(loaded ? "  loaded: yes (present in app.plugins.plugins)" : "  loaded: NO — the plugin is not registered in the app");
  } else {
    lines.push(`  loaded: unknown (${probe.detail ?? probe.status})`);
  }

  const errors = runCli(withVault(vault, ["dev:errors"]), cli);
  if (errors.status === "ok") {
    const clean = /no errors captured/i.test(errors.output);
    lines.push(clean ? "  errors: none captured" : `  errors:\n${errors.output.split("\n").map((l) => `    ${l}`).join("\n")}`);
  }
  return lines;
}

/** Best-effort signal that the capture debugger is still attached. */
function debuggerHint(): boolean {
  const probe = runCli(["dev:console", "limit=1"], { retries: 0, timeoutMs: 8_000 });
  // Without the debugger the CLI answers "Debugger not attached." — so a
  // successful console read is evidence that it IS attached.
  return probe.status === "ok" && !/debugger not attached/i.test(probe.output);
}

// ---- app-side helpers ------------------------------------------------------

/** Which vault the addressed window is showing, for failure context. */
function activeWindowVault(cli: CliOptions): string | undefined {
  const result = runCli(["vault", "info=name"], { ...cli, retries: 0, timeoutMs: 12_000 });
  return result.status === "ok" ? result.output.trim() : undefined;
}


function evalCode(vault: string | undefined, code: string, cli: CliOptions, timeoutMs?: number) {
  return runCli(withVault(vault, ["eval", `code=${code}`]), { ...cli, ...(timeoutMs ? { timeoutMs } : {}) });
}

/**
 * Refresh the app's plugin manifest index.
 *
 * Obsidian reads `.obsidian/plugins/` once, when a vault loads. Without this a
 * just-deployed plugin is invisible to every CLI plugin command.
 */
function rescanManifests(
  vault: string | undefined,
  cli: CliOptions,
  options: { force?: boolean } = {},
): { scanned?: number } | undefined {
  const result = evalCode(
    vault,
    "app.plugins.loadManifests().then(function(){return Object.keys(app.plugins.manifests||{}).length})",
    cli,
  );
  if (result.status !== "ok") {
    if (options.force) return undefined;
    return {};
  }
  const count = Number.parseInt((result.output.match(/=>\s*(\d+)/) ?? [])[1] ?? "", 10);
  return { scanned: Number.isFinite(count) ? count : undefined };
}

/** `true` = restricted, `false` = unrestricted, `undefined` = could not tell. */
function restrictionProbe(vault: string | undefined, cli: CliOptions): boolean | undefined {
  const result = evalCode(vault, "!app.plugins.isEnabled()", cli);
  if (result.status !== "ok") return undefined;
  if (/=>\s*true/.test(result.output)) return true;
  if (/=>\s*false/.test(result.output)) return false;
  return undefined;
}

async function pollUnrestricted(vault: string | undefined, cli: CliOptions): Promise<boolean | undefined> {
  // setEnable reloads the window, so the new state appears only after it settles.
  for (let i = 0; i < 6; i++) {
    await sleep(2500);
    const state = restrictionProbe(vault, cli);
    if (state === false) return false;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
