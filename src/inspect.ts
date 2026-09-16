// obsidian_plugin_inspect — read-only observation of the running app.
//
// Design rules that shape this module (DESIGN.md §4.6, §7.4, §7.5):
//
//   * `plugin:*` / `dev:*` / `eval` resolve against the ACTIVE window's vault,
//     and `vault=` does not reliably redirect them. So the tool reports which
//     vault it actually reached and never guesses.
//   * A reading must prove its own target. `status` therefore evaluates
//     `app.vault.getName()` in the app and compares it with the requested
//     vault instead of trusting the CLI's answer alone.
//   * Reading the console needs `dev:debug on` … `dev:debug off` around the
//     read, and attaching the debugger breaks `plugin:reload` while attached,
//     so the two must never be interleaved.
//   * Screenshots are written by Obsidian; the command can hang after writing
//     the file, so a timeout is resolved by checking whether the file exists.

import { join } from "node:path";
import { runCli, explainCliFailure, type CliOptions } from "./cli.js";
import type { Fs, FsCall } from "./fs.js";

export type InspectAction =
  | "status"
  | "errors"
  | "console"
  | "dom"
  | "css"
  | "screenshot"
  | "trustCheck";

export interface InspectArgs {
  projectDir?: string;
  /** Target vault: absolute path, directory name, or vault name. */
  vault?: string;
  action?: InspectAction;
  /** dom/css/target selector. */
  selector?: string;
  /** dom: text | attr | total | all | inner. */
  what?: "text" | "attr" | "total" | "all" | "inner";
  /** dom: attribute name when what=attr. */
  attr?: string;
  /** css: property name. */
  prop?: string;
  /** console: level filter; limit defaults to 50. */
  level?: "log" | "warn" | "error" | "info" | "debug";
  limit?: number;
  /** screenshot: absolute output path (must be inside the writable workspace). */
  path?: string;
  /** Clear the buffer after reading (errors/console). */
  clear?: boolean;
  /** console: leave the debugger attached instead of detaching afterwards. */
  keepDebugger?: boolean;
}

/** Output caps so console noise cannot flood the model's context (DESIGN.md §4.10). */
const MAX_LINE_CHARS = 8 * 1024;
const MAX_TOTAL_CHARS = 32 * 1024;

export function truncate(text: string, maxTotal = MAX_TOTAL_CHARS): string {
  if (text.length <= maxTotal) return text;
  return `${text.slice(0, maxTotal)}\n… [truncated: ${text.length - maxTotal} more characters; narrow the query with limit/selector]`;
}

function capLine(line: string): string {
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS)}…`;
}

/** Build the argv for a vault-targeted CLI call. */
export function cliArgs(vaultName: string | undefined, command: string[], options: { limit?: number; level?: string; clear?: boolean } = {}): string[] {
  const args: string[] = [];
  if (vaultName) args.push(`vault=${vaultName}`);
  args.push(...command);
  if (options.level) args.push(`level=${options.level}`);
  if (options.limit !== undefined) args.push(`limit=${options.limit}`);
  if (options.clear) args.push("clear");
  return args;
}

export interface InspectReport {
  action: InspectAction;
  ok: boolean;
  /** Machine-ish facts gathered for `status`. */
  facts?: Record<string, string | boolean | undefined>;
  /** Body text returned to the model. */
  body: string;
  warnings: string[];
}

/**
 * Which vault did the app actually answer from?
 *
 * Evaluated in the app so the answer cannot be confused with the CLI's own
 * notion of the active vault.
 */
export function identityProbe(code = "({vault:app.vault.getName(),appId:app.appId,restricted:!app.plugins.isEnabled()})"): string[] {
  return ["eval", `code=${code}`];
}

/** Parse the `=> { ... }` JSON block the CLI prints for an object-valued eval. */
export function parseEvalJson(output: string): any | undefined {
  const marker = output.indexOf("=>");
  if (marker < 0) return undefined;
  const body = output.slice(marker + 2).trim();
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export async function inspect(fs: Fs, args: InspectArgs, call: FsCall = {}, cli: CliOptions = {}): Promise<string> {
  const action: InspectAction = args.action ?? "status";
  switch (action) {
    case "status":
      return await status(fs, args, call, cli);
    case "errors":
      return await buffer("errors", args, cli);
    case "console":
      return await consoleBuffer(args, cli);
    case "dom":
      return await dom(args, cli);
    case "css":
      return await css(args, cli);
    case "screenshot":
      return await screenshot(fs, args, call, cli);
    case "trustCheck":
      return await trustCheck(cli);
    default:
      return `Error: unknown action "${action}".`;
  }
}

// ---- status ---------------------------------------------------------------

interface VaultRef {
  /** Directory name or the vault's registered name, used for `vault=`. */
  name?: string;
  /** Absolute path, when known. */
  path?: string;
  /** Vault id used by the app for per-vault settings. */
  appId?: string;
}

/**
 * Resolve the vault reference used to address the CLI.
 *
 * `vault=` accepts a name or an id; a directory path is not addressable, so a
 * path is reduced to its basename (which is what Obsidian registers as the
 * vault name for a conventionally opened folder).
 */
export async function resolveVaultRef(fs: Fs, args: InspectArgs, call: FsCall = {}): Promise<VaultRef> {
  const source = args.vault;
  if (!source) return {};
  if (source.includes("/") || source.includes("\\") || source.startsWith("~")) {
    const abs = await fs.resolve(source, call.workspaceRoot);
    return { path: abs, name: abs.split(/[\\/]/).filter(Boolean).pop() };
  }
  return { name: source };
}

async function status(fs: Fs, args: InspectArgs, call: FsCall, cli: CliOptions): Promise<string> {
  const warnings: string[] = [];
  const ref = await resolveVaultRef(fs, args, call);

  const version = runCli(["version"], cli);
  if (version.status === "missing" || version.status === "hang") {
    return explainCliFailure(version, "cannot read the Obsidian version");
  }

  // Identity probe first: it establishes which vault every later window-scoped
  // reading actually came from.
  const identity = runCli(cliArgs(ref.name, identityProbe()), cli);
  const facts: Record<string, string | boolean | undefined> = { obsidian: version.output };
  let activeVault: string | undefined;
  let restricted: boolean | undefined;
  if (identity.status === "ok") {
    const parsed = parseEvalJson(identity.output);
    activeVault = parsed?.vault;
    restricted = typeof parsed?.restricted === "boolean" ? parsed.restricted : undefined;
    facts.activeVault = activeVault;
    facts.restricted = restricted;
    if (ref.name && activeVault && activeVault !== ref.name) {
      warnings.push(
        `target mismatch: asked for "${ref.name}" but the app answered from "${activeVault}". ` +
          "Bring the target vault to the front (obsidian_plugin_vault action=ensure confirm=true) before trusting window-scoped readings.",
      );
    }
  } else {
    warnings.push(explainCliFailure(identity, "could not confirm which vault answered"));
  }

  const list = runCli(["vaults", "verbose"], cli);
  if (list.status === "ok") facts.registeredVaults = list.output.replace(/\n/g, ", ");

  const restrict = runCli(["plugins:restrict"], cli);
  if (restrict.status === "ok") facts.restrictedMode = restrict.output;

  const enabled = runCli(cliArgs(ref.name, ["plugins:enabled", "filter=community"]), cli);
  if (enabled.status === "ok") {
    facts.enabledCommunityPlugins = enabled.output || "(none)";
  } else if (enabled.status !== "unavailable") {
    warnings.push(explainCliFailure(enabled, "could not list enabled community plugins"));
  }

  if (args.projectDir) {
    const projectDir = await fs.resolve(args.projectDir, call.workspaceRoot);
    const manifest = await fs.readJson(join(projectDir, "manifest.json"));
    if (manifest?.id) {
      const info = runCli(cliArgs(ref.name, ["plugin", `id=${manifest.id}`]), cli);
      if (info.status === "ok") {
        facts.plugin = info.output.replace(/\n/g, " · ");
        const installed = /(^|\n)version\t([^\n]+)/.exec(info.output)?.[2];
        if (installed && manifest.version && installed !== manifest.version) {
          warnings.push(`plugin version mismatch: vault has ${installed}, project has ${manifest.version} — redeploy or reload`);
        }
        if (!/(^|\n)enabled\ttrue/.test(info.output)) {
          warnings.push(`plugin "${manifest.id}" is not enabled in this vault`);
        }
      } else if (info.status === "unavailable") {
        facts.plugin = `not installed in the addressed vault (${info.detail ?? "not found"})`;
      } else {
        warnings.push(explainCliFailure(info, "could not read the plugin's status"));
      }

      // A trust modal blocks loading and must be reported before anything else.
      const trust = runCli(cliArgs(ref.name, ["dev:dom", 'selector=.mod-trust-folder', "total"]), cli);
      if (trust.status === "ok" && /^[1-9]/.test(trust.output.trim())) {
        warnings.push(
          "trust confirmation is pending (.mod-trust-folder present): Obsidian will not load community plugins in this vault until the user accepts it",
        );
        facts.trust = "pending";
      } else {
        facts.trust = "none-detected";
      }
    } else {
      warnings.push("projectDir has no readable manifest.json — skipped the plugin check");
    }
  }

  const lines = [`Obsidian ${version.output.split("\n")[0]}`];
  for (const [key, value] of Object.entries(facts)) {
    if (key === "obsidian") continue;
    lines.push(`  ${key}: ${value}`);
  }
  for (const warning of warnings) lines.push(`  ! ${warning}`);
  if (warnings.length === 0) lines.push("  All checks clean.");
  return truncate(lines.join("\n"));
}

// ---- buffers and queries --------------------------------------------------

async function buffer(kind: "errors", args: InspectArgs, cli: CliOptions): Promise<string> {
  const result = runCli(["dev:errors", ...(args.clear ? ["clear"] : [])], cli);
  if (result.status !== "ok") return explainCliFailure(result, `could not read the ${kind} buffer`);
  return truncate(result.output.split("\n").map(capLine).join("\n"));
}

async function consoleBuffer(args: InspectArgs, cli: CliOptions): Promise<string> {
  // Console capture only exists while the debugger is attached.
  const attach = runCli(["dev:debug", "on"], cli);
  if (attach.status !== "ok") return explainCliFailure(attach, "could not attach the console-capture debugger");

  const read = runCli(["dev:console", ...(args.level ? [`level=${args.level}`] : []), `limit=${args.limit ?? 50}`, ...(args.clear ? ["clear"] : [])], cli);

  let detachNote = "";
  if (args.keepDebugger) {
    detachNote = "\n  ! debugger left ATTACHED — plugin:reload will hang until you detach it (dev:debug off)";
  } else {
    const detach = runCli(["dev:debug", "off"], cli);
    detachNote = detach.status === "ok" ? "\n  (debugger detached again)" : `\n  ! could not detach the debugger: ${detach.detail ?? detach.status}`;
  }

  if (read.status !== "ok") return explainCliFailure(read, "could not read the console buffer") + detachNote;
  return truncate(read.output.split("\n").map(capLine).join("\n")) + detachNote;
}

async function dom(args: InspectArgs, cli: CliOptions): Promise<string> {
  if (!args.selector) return 'Error: action="dom" requires selector.';
  const mode = args.what ?? "text";
  const argv = ["dev:dom", `selector=${args.selector}`];
  if (mode === "attr") {
    if (!args.attr) return 'Error: what="attr" requires attr=<name>.';
    argv.push(`attr=${args.attr}`);
  } else if (mode !== "text") {
    argv.push(mode);
  }
  const result = runCli(argv, cli);
  if (result.status !== "ok") return explainCliFailure(result, `could not query DOM for "${args.selector}"`);
  return truncate(result.output.split("\n").map(capLine).join("\n"));
}

async function css(args: InspectArgs, cli: CliOptions): Promise<string> {
  if (!args.selector) return 'Error: action="css" requires selector.';
  const argv = ["dev:css", `selector=${args.selector}`];
  if (args.prop) argv.push(`prop=${args.prop}`);
  const result = runCli(argv, cli);
  if (result.status !== "ok") return explainCliFailure(result, `could not inspect CSS for "${args.selector}"`);
  return truncate(result.output);
}

async function trustCheck(cli: CliOptions): Promise<string> {
  // The modal renders asynchronously after a window opens, so a single miss
  // proves nothing; poll a few times before saying "no".
  const attempts = 5;
  for (let i = 1; i <= attempts; i++) {
    const result = runCli(["dev:dom", "selector=.mod-trust-folder", "total"], { ...cli, retries: 0 });
    if (result.status === "ok") {
      const count = Number.parseInt(result.output.trim(), 10);
      if (Number.isFinite(count) && count > 0) return `trust modal present (${count}) — Obsidian will not load community plugins until the user accepts it`;
      if (i === attempts) return "no trust modal detected";
    } else if (result.status === "unavailable") {
      return explainCliFailure(result, "could not query the DOM");
    }
    await sleep(1500);
  }
  return "no trust modal detected (after polling)";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function screenshot(fs: Fs, args: InspectArgs, call: FsCall, cli: CliOptions): Promise<string> {
  if (!args.path) return 'Error: action="screenshot" requires path=<absolute path inside the workspace>.';
  const target = await fs.resolve(args.path, call.workspaceRoot);

  const result = runCli(["dev:screenshot", `path=${target}`], cli);

  // The CLI is known to hang after Obsidian has already written the file, so a
  // timeout is resolved by looking at the filesystem rather than the status.
  if (result.status !== "ok") {
    if (await fs.exists(target)) {
      return `Wrote ${target} (the CLI call did not return: ${result.detail ?? result.status}). Read it with the image tool.`;
    }
    return explainCliFailure(result, `could not capture a screenshot to ${target}`);
  }
  if (!(await fs.exists(target))) {
    return `Obsidian reported success but no file appeared at ${target} — check that the path is writable.`;
  }
  return `Wrote ${target}. Read it with the image tool.`;
}
