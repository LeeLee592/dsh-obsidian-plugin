// obsidian_plugin_build — bundle a plugin project into a loadable main.js and
// run the L1 static self-checks.
//
// Design decisions of record (DESIGN.md §4.1):
//
//   * Three-tier degradation, and the tier actually used is always reported:
//       L1 project-local esbuild binary (also covers projects whose own
//         esbuild.config.mjs would enter watch mode and never exit)
//       L2 project build script (production only — `dev` watches forever)
//       L3 refuse with an actionable message
//   * We never invoke `pnpm run dev`: it is a long-running watcher, and a tool
//     call must return.
//   * L1 checks are static scans. They are reported as such — a static scan is
//     not a load test, and the output must not imply otherwise.

import { Buffer } from "node:buffer";
import { join } from "node:path";
import { builtinModules } from "node:module";
import { isSemver, namingProblems } from "./naming.js";
import { run, type RunResult } from "./proc.js";
import type { Fs, FsCall } from "./fs.js";

/**
 * Everything esbuild must treat as provided by the Obsidian/Electron runtime.
 *
 * Node builtins are included in both spellings (`crypto` and `node:crypto`):
 * plugins run inside Electron's renderer and legitimately import them, and
 * esbuild would otherwise try to bundle them and fail to resolve. Both the
 * official sample-plugin config and real-world plugins externalize this set.
 */
const EXTERNAL = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  ...new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]),
];

export interface BuildArgs {
  projectDir: string;
  /** Defaults to true. Dev builds add an inline sourcemap. */
  production?: boolean;
}

export interface BuildReport {
  ok: boolean;
  projectDir?: string;
  pluginId?: string;
  version?: string;
  tier?: string;
  outputBytes?: number;
  failures: string[];
  warnings: string[];
}

const TIER_L1 = "project-local esbuild";
const TIER_L2 = "project build script (production)";
const TIER_L3 = "none";

/** Render the report the model sees. Plain text, short, always ends with a next step. */
export function renderBuildReport(report: BuildReport, text = ""): string {
  if (!report.ok) {
    const head = text || "Build failed.";
    const body = report.failures.length ? `\n${report.failures.map((f) => `- ${f}`).join("\n")}` : "";
    return head + body;
  }
  const kb = ((report.outputBytes ?? 0) / 1024).toFixed(1);
  const lines = [
    `Built ${report.pluginId} ${report.version} → main.js (${kb} KB) via ${report.tier}`,
    `Checks: ${report.warnings.length === 0 ? "all passed" : `${report.warnings.length} warning(s)`}`,
  ];
  for (const w of report.warnings) lines.push(`  ! ${w}`);
  lines.push('Note: checks are static scans of the bundle, not a load test.');
  lines.push(`Next: obsidian_plugin_deploy projectDir="${report.projectDir}"`);
  return lines.join("\n");
}

export async function buildPlugin(fs: Fs, args: BuildArgs, call: FsCall = {}): Promise<string> {
  const report: BuildReport = { ok: false, failures: [], warnings: [] };

  const projectDir = await fs.resolve(args.projectDir, call.workspaceRoot);
  report.projectDir = projectDir;

  const manifest = await fs.readJson(join(projectDir, "manifest.json"));
  if (!manifest || typeof manifest.id !== "string" || manifest.id.trim() === "") {
    report.failures.push("manifest.json not found, invalid JSON, or missing a string \"id\"");
    return renderBuildReport(report);
  }
  report.pluginId = manifest.id;
  report.version = manifest.version;

  const entry = join(projectDir, "src", "main.ts");
  if (!(await fs.exists(entry))) {
    report.failures.push(`entry point not found: ${join(args.projectDir, "src", "main.ts")} — expected a TypeScript plugin at src/main.ts`);
    return renderBuildReport(report);
  }

  const production = args.production !== false;
  const bin = join(projectDir, "node_modules", ".bin", "esbuild");

  let result: RunResult | undefined;

  if (await fs.exists(bin)) {
    report.tier = TIER_L1;
    result = run({
      command: bin,
      args: buildArgs(production),
      cwd: projectDir,
      timeoutMs: 180_000,
    });
  } else {
    const pkg = await fs.readJson(join(projectDir, "package.json"));
    const hasBuildScript = typeof pkg?.scripts?.build === "string";
    if (hasBuildScript && production) {
      // L2 deliberately restricted to the production script: `dev` starts a
      // watcher that never exits.
      report.tier = TIER_L2;
      const pm = (await fs.exists(join(projectDir, "pnpm-lock.yaml"))) ? "pnpm" : "npm";
      result = run({ command: pm, args: ["run", "build"], cwd: projectDir, timeoutMs: 300_000 });
    } else {
      report.tier = TIER_L3;
      report.failures.push(
        "no local esbuild and no usable build script: run `pnpm install` in the plugin project, " +
        "or add a `build` script that produces main.js in production mode",
      );
      return renderBuildReport(report);
    }
  }

  if (!result.ok) {
    const detail = result.output || result.errorMessage || "(no output)";
    report.failures.push(`esbuild step failed (${result.reason}):\n${detail}`);
    return renderBuildReport(report, `Build failed via ${report.tier}.`);
  }

  const mainJs = join(projectDir, "main.js");
  if (!(await fs.exists(mainJs))) {
    report.failures.push(`esbuild reported success but ${join(args.projectDir, "main.js")} does not exist — the bundler output path differs from the Obsidian convention`);
    return renderBuildReport(report, `Build failed via ${report.tier}.`);
  }

  const bundle = await fs.readText(mainJs);
  report.outputBytes = Buffer.byteLength(bundle);
  if (report.outputBytes === 0) {
    report.failures.push("main.js is empty");
    return renderBuildReport(report, `Build failed via ${report.tier}.`);
  }

  // ---- L1 static self-checks -------------------------------------------------
  if (!/\bmodule\.exports\b|\bexports\.[A-Za-z_$]/.test(bundle)) {
    if (/^\s*(import|export)\s/m.test(bundle)) {
      report.failures.push("main.js looks like an ES module; Obsidian loads CommonJS — set `format: \"cjs\"` in the esbuild config");
      return renderBuildReport(report, `Build failed via ${report.tier}.`);
    }
    report.warnings.push("no CommonJS export detected in main.js; the plugin entry class is probably not exported");
  }

  if (!/require\(\s*["']obsidian["']\s*\)/.test(bundle) && !/from\s*["']obsidian["']/.test(bundle)) {
    report.warnings.push("no runtime reference to \"obsidian\" found in the bundle; if the API got bundled instead of externalized the plugin will misbehave at load time");
  }

  const versions = await fs.readJson(join(projectDir, "versions.json"));
  if (versions && typeof versions === "object" && manifest.version && versions[manifest.version] === undefined) {
    report.warnings.push(`versions.json has no entry for ${manifest.version} — run obsidian_plugin_validate before releasing`);
  }
  const pkg = await fs.readJson(join(projectDir, "package.json"));
  if (pkg && manifest.version && pkg.version !== manifest.version) {
    report.warnings.push(`package.json version "${pkg.version}" != manifest.json "${manifest.version}"`);
  }

  const naming = namingProblems(manifest.id, manifest.name ?? "", manifest.description ?? "");
  if (naming.length) report.warnings.push(`manifest violates submission rules: ${naming.join("; ")}`);
  if (manifest.version && !isSemver(manifest.version)) {
    report.warnings.push(`manifest version "${manifest.version}" is not semver`);
  }

  report.ok = true;
  return renderBuildReport(report);
}

/** The esbuild argv used for tier L1 — mirrors the official sample-plugin config. */
export function buildArgs(production: boolean): string[] {
  return [
    "src/main.ts",
    "--bundle",
    ...EXTERNAL.map((name) => `--external:${name}`),
    "--format=cjs",
    "--target=es2018",
    "--platform=browser",
    "--log-level=warning",
    "--sourcemap=inline",
    "--outfile=main.js",
  ];
}

/** Exposed for tests: artifact paths a built project must produce. */
export function artifactPaths(projectDir: string): { main: string; manifest: string; styles: string } {
  return {
    main: join(projectDir, "main.js"),
    manifest: join(projectDir, "manifest.json"),
    styles: join(projectDir, "styles.css"),
  };
}
