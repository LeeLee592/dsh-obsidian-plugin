// obsidian_plugin_eval — run JavaScript in the running app (DESIGN.md §4.8).
//
// This is the tool the session logs kept asking for. In both analysed sessions
// the agent reached for the Obsidian CLI through bash (79% and 31% of all calls)
// because it needed to read live state and poke at the editor — and it had to
// build its own timeout wrapper, retry loop and error handling by hand. Those
// three things are what this module supplies.
//
// It is deliberately the only high-privilege tool: registering it separately
// keeps the read-only surface (`inspect`) approval-free, and makes the approval
// prompt mean exactly one thing — "run this code inside my Obsidian".

import { runCli, explainCliFailure, type CliOptions } from "./cli.js";
import { truncate } from "./inspect.js";

export interface EvalArgs {
  /** JavaScript to run in the app context. */
  code: string;
  /** Target vault name used to address the CLI. */
  vault?: string;
  /** Extra timeout for long-running expressions. */
  timeoutMs?: number;
}

/** Calls that take the user's window and mouse focus — never silently. */
const FOCUS_PATTERNS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /getCurrentWindow\s*\(\s*\)/, what: "electron.remote.getCurrentWindow()" },
  { pattern: /BrowserWindow\s*\(/, what: "BrowserWindow construction" },
  { pattern: /\.focus\s*\(\s*\)/, what: ".focus()" },
  { pattern: /moveTop\s*\(/, what: "moveTop()" },
  { pattern: /setAlwaysOnTop\s*\(/, what: "setAlwaysOnTop()" },
];

/**
 * Flag code that would move the user's focus.
 *
 * Not a refusal: `vault ensure` legitimately needs to raise a window, and the
 * user approves every eval call anyway. But the analysed sessions show how
 * easily this happens by accident (forty calls in one session), so the caller is
 * told, in the result, that the focus may have moved.
 */
export function focusWarning(code: string): string | undefined {
  const hits = FOCUS_PATTERNS.filter(({ pattern }) => pattern.test(code)).map(({ what }) => what);
  if (hits.length === 0) return undefined;
  return (
    `! this code touches window focus (${hits.join(", ")}) — if it ran, the user's focus may have jumped to Obsidian. ` +
    "Only do this when the task genuinely needs the window in front, and say so in your summary; " +
    "the sandboxed e2e tier needs no window at all."
  );
}

export async function evalInApp(args: EvalArgs, cli: CliOptions = {}): Promise<string> {
  if (typeof args.code !== "string" || args.code.trim() === "") {
    return 'Error: `code` is required — provide the JavaScript to run in the app context (e.g. code="app.vault.getName()").';
  }

  const argv = args.vault ? [`vault=${args.vault}`, "eval", `code=${args.code}`] : ["eval", `code=${args.code}`];
  const result = runCli(argv, { ...cli, timeoutMs: args.timeoutMs ?? 30_000 });

  if (result.status !== "ok") {
    const active = activeVault(cli);
    const context = active
      ? [`  addressed window answered from vault: "${active}"${args.vault && args.vault !== active ? ` (asked for "${args.vault}")` : ""}`]
      : [];
    return [explainCliFailure(result, "could not evaluate in the app"), ...context].join("\n");
  }

  const warning = focusWarning(args.code);
  const body = truncate(result.output.trim());
  // Echo the executed code: this is the audit trail for a privileged call.
  return [`Ran in the app context:`, indent(args.code), "Result:", indent(body), ...(warning ? [warning] : [])].join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

/** Which vault the addressed window shows — for failure context. */
function activeVault(cli: CliOptions): string | undefined {
  const result = runCli(["vault", "info=name"], { ...cli, retries: 0, timeoutMs: 12_000 });
  return result.status === "ok" ? result.output.trim() : undefined;
}
