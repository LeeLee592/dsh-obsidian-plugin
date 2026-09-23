// obsidian_plugin_test — offline smoke (L2, DESIGN.md §4.3).
//
// Runs `assets/harness/harness.cjs` against the project's built bundle and turns
// its machine-readable result into a report.
//
// Positioning discipline: most popular plugins ship no tests at all, so this is
// not the main verification path — it is the floor that catches "crashes on
// load" when a live app is unavailable. The report always says so.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./proc.js";
import { resolveArtifact, resolveEntry } from "./lookup.js";
import type { Fs, FsCall } from "./fs.js";

const HARNESS_PATH = fileURLToPath(new URL("../assets/harness/harness.cjs", import.meta.url));
const RESULT_MARKER = "__HARNESS_RESULT__";

export interface TestArgs {
  projectDir: string;
  /** Explicit bundle path, overriding artifact discovery. */
  bundle?: string;
  /** Project-relative scenario module (dsh/scenarios/<name>.mjs). */
  scenario?: string;
  timeoutMs?: number;
}

interface HarnessCheck {
  name: string;
  level: "pass" | "warn" | "fail";
  detail?: string;
}

interface HarnessResult {
  ok: boolean;
  bundle?: string;
  dom?: boolean;
  domSource?: string;
  peerModules?: string[];
  pluginId?: string;
  registrations?: string[];
  /** How many registered view plugins could be instantiated (0 when no DOM host). */
  viewPluginsRun?: number;
  viewPluginsRegistered?: number;
  viewPluginsFailed?: string[];
  console?: Array<{ level: string; text: string }>;
  scenario?: string;
  checks: HarnessCheck[];
  summary: string;
}

/** Parse the harness's trailing marker line. Pure, so it is unit-testable. */
export function parseHarnessOutput(stdout: string): HarnessResult | undefined {
  const line = stdout
    .split("\n")
    .reverse()
    .find((entry) => entry.startsWith(RESULT_MARKER));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(RESULT_MARKER.length).trim()) as HarnessResult;
  } catch {
    return undefined;
  }
}

export function renderSmokeReport(result: HarnessResult, humanOutput: string): string {
  if (!result.ok) {
    const failed = result.checks.filter((c) => c.level === "fail");
    const head = `Smoke test: FAIL — ${result.summary}`;
    const body = failed.map((c) => `  ✗ ${c.name}: ${c.detail ?? ""}`.trimEnd()).join("\n");
    const rest = result.checks.filter((c) => c.level === "warn" && c.detail).map((c) => `  ! ${c.name}: ${c.detail}`);
    return [
      head,
      body,
      ...rest,
      offlineNote(result),
      failed.length ? "" : humanOutput,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }

  const warnings = result.checks.filter((c) => c.level === "warn");
  const lines = [
    `Smoke test: PASS (${result.checks.length - warnings.length} checks${warnings.length ? `, ${warnings.length} warning(s)` : ""})`,
  ];
  for (const check of warnings) lines.push(`  ! ${check.name}: ${check.detail ?? ""}`.trimEnd());
  if (result.registrations?.length) {
    lines.push(`  registered: ${result.registrations.slice(0, 8).join(", ")}${result.registrations.length > 8 ? ", …" : ""}`);
  }
  if (!result.dom) {
    lines.push("  ! no DOM host was available — a DOM-dependent plugin may not have been exercised fully");
  }
  const consoleErrors = (result.console ?? []).filter((entry) => entry.level === "error");
  if (consoleErrors.length) {
    lines.push(`  ! ${consoleErrors.length} console.error during the run, first: ${consoleErrors[0].text.slice(0, 200)}`);
  }
  lines.push(offlineNote(result));
  return lines.join("\n");
}

/**
 * The limit, stated per run rather than as boilerplate.
 *
 * With no DOM host the reach really is "loads, registers, unloads"; a DOM host
 * additionally runs the registered view plugins, which is where a plugin whose
 * feature is its UI actually lives. Saying the same thing in both cases would
 * understate the second and, worse, let the first read as if the UI had been
 * checked.
 */
function offlineNote(result: HarnessResult): string {
  const head = result.dom
    ? "Note: offline stub environment, NOT the real app — this proves the bundle loads, registers, unloads,"
    : "Note: offline stub environment, NOT the real app — this only proves the bundle loads, registers and unloads.";
  const middle = result.dom
    ? "\n      and that the registered view plugins can be constructed against a stub view. Rendering, events and"
    : "\n      UI code registered as an editor extension was NOT exercised: no DOM host was available.";
  // The stub's vault is always empty (its file map is never populated), so a
  // plugin that iterates notes sees none offline. Saying so here stops a reader
  // concluding "the plugin found no notes" from a smoke-test pass.
  const vaultNote =
    "\n      The stub vault is EMPTY: vault.getFiles() and the metadata cache return nothing, so note-dependent logic is not exercised here.";
  const next = result.viewPluginsRegistered
    ? "\nNext: this run registered view plugin(s). If your change touched the UI, a PASS here is NOT acceptance — " +
      "see it in a running app (obsidian_plugin_e2e, or obsidian_plugin_inspect action=screenshot), because the stub has no editor."
    : "\nNext: for anything that needs a real editor or the real vault, use obsidian_plugin_e2e (sandboxed, no window) " +
      "or obsidian_plugin_inspect against a running app.";
  return `${head}${middle}${vaultNote}${next}`;
}

export async function testPlugin(fs: Fs, args: TestArgs, call: FsCall = {}): Promise<string> {
  const projectDir = await fs.resolve(args.projectDir, call.workspaceRoot);

  const manifest = await fs.readJson(join(projectDir, "manifest.json"));
  if (!manifest || typeof manifest.id !== "string") {
    return 'Error: manifest.json not found, invalid JSON, or missing a string "id".';
  }

  // Bundle: explicit path, then artifact discovery (the same chain `build` uses,
  // so a project that builds into its own test vault is found here too).
  let bundle = args.bundle ? await fs.resolve(args.bundle, call.workspaceRoot) : undefined;
  if (bundle) {
    if (!(await fs.exists(bundle))) return `Error: bundle not found: ${bundle}`;
  } else {
    const found = await resolveArtifact(fs, projectDir, { pluginId: manifest.id });
    if (!found.ok) {
      return [
        "Error: no built bundle found — run obsidian_plugin_build first.",
        "Looked for main.js in:",
        ...found.tried.map((t) => `  - ${t}`),
      ].join("\n");
    }
    bundle = found.resolution.path;
  }

  const argv = [HARNESS_PATH, projectDir, "--bundle", bundle];
  if (args.scenario) argv.push("--scenario", args.scenario);

  const result = run({ command: process.execPath, args: argv, cwd: projectDir, timeoutMs: args.timeoutMs ?? 120_000 });

  if (result.reason === "timeout") {
    return [
      `Smoke test: FAIL — the harness did not finish within ${(args.timeoutMs ?? 120_000) / 1000}s.`,
      "A plugin that never settles during load is a real finding; if it is intentional, raise timeoutMs.",
      offlineNote({ ok: false, dom: false, checks: [], summary: "" }),
    ].join("\n");
  }

  const parsed = parseHarnessOutput(result.stdout ?? "");
  if (!parsed) {
    return [
      "Smoke test: FAIL — the harness produced no result.",
      result.output ? `Harness output:\n${result.output}` : "(no output)",
      offlineNote({ ok: false, dom: false, checks: [], summary: "" }),
    ].join("\n");
  }
  return renderSmokeReport(parsed, (result.stdout ?? "").trim());
}
