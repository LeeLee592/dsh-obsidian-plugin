// External process execution for the build/deploy half of the plugin.
//
// Two lessons from live-app verification are baked in here (see DESIGN.md §7):
//
//   1. Never trust an exit code alone. The Obsidian CLI reports errors with a
//      zero exit status, so callers must classify by output.
//   2. A silent timeout is not success. An empty result means the call hung;
//      it is a distinct outcome from "ran fine and printed nothing".

import { spawnSync } from "node:child_process";

export interface RunSpec {
  /** Executable path or bare PATH name. */
  command: string;
  args?: string[];
  cwd?: string;
  /** Hard deadline; a call exceeding it is killed and reported as timed out. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  ok: boolean;
  /** Why it failed, when it did. */
  reason?: "spawn-error" | "timeout" | "nonzero-exit";
  status: number | null;
  stdout: string;
  stderr: string;
  /** Combined, trimmed output — what a caller usually wants to show. */
  output: string;
  errorMessage?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function run(spec: RunSpec): RunResult {
  const result = spawnSync(spec.command, spec.args ?? [], {
    cwd: spec.cwd,
    encoding: "utf8",
    timeout: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: spec.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = (stdout.trim() || stderr.trim());
  const base = { status: result.status, stdout, stderr, output };

  // spawnSync sets `error` for ENOENT/EACCES and, separately, when the
  // `timeout` fired (error.code === 'ETIMEDOUT').
  const error = result.error as (NodeJS.ErrnoException & { code?: string }) | undefined;
  if (error) {
    const timedOut = error.code === "ETIMEDOUT" || (result.signal === "SIGTERM" && result.status === null);
    return {
      ...base,
      ok: false,
      reason: timedOut ? "timeout" : "spawn-error",
      errorMessage: error.message,
    };
  }
  if (result.status !== 0) return { ...base, ok: false, reason: "nonzero-exit" };

  return { ...base, ok: true };
}
