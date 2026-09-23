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
import { join, relative } from "node:path";
import { builtinModules } from "node:module";
import { isSemver, namingProblems } from "./naming.js";
import { readConfigs, renderLookupFailure, resolveArtifact, resolveEntry } from "./lookup.js";
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
  /** Explicit entry file, overriding the resolution chain. */
  entry?: string;
  /** Explicit output directory for main.js, overriding artifact discovery. */
  outDir?: string;
}

export interface BuildReport {
  ok: boolean;
  projectDir?: string;
  pluginId?: string;
  version?: string;
  tier?: string;
  outputBytes?: number;
  /** Entry file that was built, relative to the project. */
  entryPath?: string;
  entrySource?: string;
  /** main.js location, relative to the project. */
  artifactPath?: string;
  artifactSource?: string;
  failures: string[];
  warnings: string[];
}

/**
 * Tiers, in evaluation order. The project's own build script comes FIRST
 * whenever the project has a bundler config, because that config may rely on
 * plugins we cannot supply from the command line — obsidian-tasks needs
 * esbuild-svelte/esbuild-sass-plugin for `.svelte`/`.scss` inputs, and invoking
 * esbuild directly fails on it with "No loader is configured for .svelte".
 */
const TIER_SCRIPT = "project build script (production)";
const TIER_DIRECT = "project-local esbuild (direct)";
const TIER_NONE = "none";

/** Config files that carry bundler plugins, making the project script authoritative. */
const BUNDLER_CONFIGS = [
  "esbuild.config.mjs",
  "esbuild.config.js",
  "esbuild.config.ts",
  "rollup.config.js",
  "rollup.config.mjs",
  "rollup.config.ts",
  "vite.config.ts",
  "vite.config.js",
];

/** Render the report the model sees. Plain text, short, always ends with a next step. */
export function renderBuildReport(report: BuildReport, text = ""): string {
  if (!report.ok) {
    const head = text || "Build failed.";
    const body = report.failures.length ? `\n${report.failures.map((f) => `- ${f}`).join("\n")}` : "";
    return head + body;
  }
  const kb = ((report.outputBytes ?? 0) / 1024).toFixed(1);
  const lines = [
    `Built ${report.pluginId} ${report.version} → ${report.artifactPath ?? "main.js"} (${kb} KB) via ${report.tier}`,
    `  entry:    ${report.entryPath ?? "src/main.ts"} (${report.entrySource ?? "default"})`,
    `  artifact: ${report.artifactPath ?? "main.js"} (${report.artifactSource ?? "project root"})`,
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

  // Entry point: resolved from the project's own configuration, because real
  // plugins use `src/main.ts`, a repository-root `main.ts`, or something like
  // `src/plugin/main.ts` (DESIGN.md §2.8).
  const entryLookup = await resolveEntry(fs, projectDir, { entry: args.entry });
  if (!entryLookup.ok) {
    report.failures.push(
      renderLookupFailure("entry", { ...entryLookup.failure, projectDir }).replace(/^Error: /, "Error: entry point not found — "),
    );
    return renderBuildReport(report);
  }
  const entry = entryLookup.resolution.path;
  report.entryPath = entryLookup.resolution.displayPath;
  report.entrySource = entryLookup.resolution.source;

  const production = args.production !== false;
  const bin = join(projectDir, "node_modules", ".bin", "esbuild");
  const pkg = await fs.readJson(join(projectDir, "package.json"));
  const buildScript = typeof pkg?.scripts?.build === "string" ? pkg.scripts.build : undefined;
  const hasBundlerConfig = (await readConfigs(fs, projectDir)).size > 0;
  const hasEsbuild = await fs.exists(bin);

  let result: RunResult | undefined;

  if (buildScript && production) {
    // Deliberately the *production* script only: `dev` enters watch mode and
    // never exits (float-mark's config calls context.watch()).
    report.tier = TIER_SCRIPT;
    const pm = (await fs.exists(join(projectDir, "pnpm-lock.yaml"))) ? "pnpm" : "npm";
    result = run({ command: pm, args: ["run", "build"], cwd: projectDir, timeoutMs: 300_000 });
  } else if (hasEsbuild && !hasBundlerConfig) {
    // No project config to honour, so our own flags are the whole truth.
    report.tier = TIER_DIRECT;
    result = run({
      command: bin,
      args: buildArgs(production, entryLookup.resolution.displayPath),
      cwd: projectDir,
      timeoutMs: 180_000,
    });
  } else if (hasEsbuild && hasBundlerConfig && !production) {
    report.tier = TIER_DIRECT;
    result = run({
      command: bin,
      args: buildArgs(production, entryLookup.resolution.displayPath),
      cwd: projectDir,
      timeoutMs: 180_000,
    });
    report.warnings.push(
      "built with our own esbuild flags because production=false; the project's bundler plugins were NOT applied",
    );
  } else {
    report.tier = TIER_NONE;
    report.failures.push(
      hasBundlerConfig
        ? "the project has a bundler config but no usable `build` script: add one that builds in production mode (we deliberately never run `dev`, which watches forever)"
        : "no local esbuild and no usable build script: run `pnpm install` in the plugin project, or add a `build` script",
    );
    return renderBuildReport(report);
  }

  if (!result.ok) {
    const detail = result.output || result.errorMessage || "(no output)";
    report.failures.push(`esbuild step failed (${result.reason}):\n${detail}`);
    return renderBuildReport(report, `Build failed via ${report.tier}.`);
  }

  // Artifact: also discovered, because a real project may build into `dir: '.'`
  // or straight into its own test vault (obsidian-tasks, dataview,
  // editing-toolbar — see DESIGN.md §2.8).
  const artifactLookup = args.outDir
    ? await resolveArtifact(fs, await fs.resolve(args.outDir, call.workspaceRoot), { pluginId: manifest.id })
    : await resolveArtifact(fs, projectDir, { pluginId: manifest.id });
  if (!artifactLookup.ok) {
    report.failures.push(
      [
        `${report.tier} reported success but no main.js could be located.`,
        "Tried:",
        ...artifactLookup.tried.map((t) => `  - ${t}`),
        'Pass outDir="<dir>" explicitly, or make the build write main.js into the project root.',
      ].join("\n"),
    );
    return renderBuildReport(report, `Build failed via ${report.tier}.`);
  }
  const mainJs = artifactLookup.resolution.path;
  report.artifactPath = join(relative(projectDir, artifactLookup.resolution.dir) || ".", "main.js");
  report.artifactSource = artifactLookup.resolution.source;
  if (artifactLookup.resolution.source === "search") {
    report.warnings.push(`main.js was found by search at ${report.artifactPath} — pass outDir to skip the search`);
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
export function buildArgs(production: boolean, entry = "src/main.ts"): string[] {
  return [
    entry,
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
