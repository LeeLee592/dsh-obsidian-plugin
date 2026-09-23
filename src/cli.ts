// Obsidian CLI invocation: the one place that knows how the CLI fails.
//
// This module exists because the CLI's failure modes are not expressible with
// exit codes alone (DESIGN.md §2.2, §7):
//
//   * errors are printed but the process still exits 0;
//   * a hung call returns NO output at all with exit status 0 — indistinguishable
//     from "ran fine, printed nothing" unless emptiness is its own category;
//   * the same command is sometimes slow and succeeds on a retry;
//   * `Command "x" not found` means the command surface does not apply here
//     (wrong window/vault), which is a different recovery from a real error.
//
// Everything that talks to Obsidian goes through `runCli` so those rules are
// applied once.

import { run } from "./proc.js";
import type { RunResult } from "./proc.js";

const DEFAULT_CLI_TIMEOUT_MS = 20_000;
const DEFAULT_CLI_RETRIES = 1;

export type CliStatus =
  /** The command produced usable output. */
  | "ok"
  /** The CLI reported a business error (output starts with `Error:`). */
  | "error"
  /** The command/handler does not exist in the target window: wrong vault or older CLI. */
  | "unavailable"
  /** Nothing came back: the CLI hung or the app never answered. */
  | "hang"
  /** The `obsidian` executable could not be spawned at all. */
  | "missing";

export interface CliResult {
  status: CliStatus;
  /** Trimmed output; empty for `hang` and `missing`. */
  output: string;
  attempts: number;
  timeoutMs: number;
  /** Set for `error`, `unavailable`, `hang` and `missing`. */
  detail?: string;
}

export interface CliOptions {
  /** Total attempts (1 = no retry). */
  retries?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Caller cancellation; also checked between attempts. */
  signal?: AbortSignal;
}

/** Patterns the CLI uses when the handler is absent in the addressed window. */
const UNAVAILABLE_PATTERNS = [
  /^Error: Command ".*" not found\b/m,
  /^Error: Plugin ".*" not found\b/m,
  /it may require a plugin to be enabled/i,
  /^Vault not found\./m,
];

/**
 * Classify one invocation's raw result. Pure so it can be tested without
 * spawning anything.
 */
export function classify(result: Pick<RunResult, "ok" | "reason" | "output" | "errorMessage">): {
  status: CliStatus;
  detail?: string;
} {
  if (result.reason === "spawn-error") {
    return { status: "missing", detail: result.errorMessage ?? "obsidian CLI not found on PATH" };
  }
  if (result.reason === "timeout") {
    return {
      status: "hang",
      detail: "no response before the timeout — the CLI can hang; retry, and if it persists restart Obsidian",
    };
  }

  const output = result.output ?? "";
  if (output.trim() === "") {
    // A zero exit with no output is the CLI's silent-hang signature, not success.
    return {
      status: "hang",
      detail: "empty output with a zero exit status — treated as a hang, not as success",
    };
  }
  if (UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(output))) {
    return { status: "unavailable", detail: firstLine(output) };
  }
  if (!result.ok || /^Error:/m.test(output)) {
    return { status: "error", detail: firstLine(output) };
  }
  return { status: "ok" };
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") ?? text).trim();
}

/**
 * Run one Obsidian CLI command, retrying the retryable outcomes.
 *
 * `hang` is retried (the CLI is intermittently slow); `error` and
 * `unavailable` are not — retrying a deterministic answer only wastes time.
 */
export function runCli(args: string[], options: CliOptions = {}): CliResult {
  const retries = options.retries ?? DEFAULT_CLI_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const attempts = Math.max(1, retries + 1);

  let last: CliResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) {
      return { status: "hang", output: "", attempts: attempt, timeoutMs, detail: "cancelled by the caller" };
    }
    const raw = run({
      command: "obsidian",
      args,
      timeoutMs,
      env: options.env,
    });
    const { status, detail } = classify(raw);
    last = { status, output: status === "ok" || status === "error" || status === "unavailable" ? raw.output : "", attempts: attempt, timeoutMs, detail };
    if (status !== "hang") return last;
  }
  return last!;
}

/**
 * Turn a non-ok result into a short, actionable message. Used as the shared
 * degradation text for every window-scoped capability.
 */
export function explainCliFailure(result: CliResult, context: string): string {
  switch (result.status) {
    case "missing":
      return `Obsidian CLI not available — ${context}. Install/register it from Obsidian: Settings → General → Command line interface.`;
    case "hang":
      return `Obsidian did not respond — ${context}. ${result.detail ?? ""}`.trim();
    case "unavailable":
      return `Command not available in the addressed window — ${context}. Bring the target vault to the front first (obsidian_plugin_vault action=ensure). Detail: ${result.detail ?? ""}`.trim();
    case "error":
      return `Obsidian reported an error — ${context}. ${result.detail ?? ""}`.trim();
    default:
      return `Unexpected CLI result — ${context}.`;
  }
}
