// Entry-point and artifact resolution for real-world plugin projects.
//
// Hardcoding `src/main.ts` and a project-root `main.js` fails on real projects
// (DESIGN.md §2.8): the sampled popular plugins use three entry shapes
// (`src/main.ts`, a repository-root `main.ts`, `src/plugin/main.ts`) and three
// output shapes (project root, `dir: '.'`, a directory inside the project —
// often a test vault). So both are resolved from the project's own
// configuration, and every failure lists what was tried.

import { dirname, isAbsolute, join, relative } from "node:path";
import type { Fs } from "./fs.js";

export type EntrySource =
  | "argument"
  | "src/main.ts"
  | "main.ts"
  | "esbuild config"
  | "rollup config"
  | "vite config"
  | "package.json main";

export interface EntryResolution {
  /** Absolute path of the entry file. */
  path: string;
  /** Workspace-relative display form, when inside the project. */
  displayPath: string;
  source: EntrySource;
}

export interface EntryFailure {
  tried: string[];
  header: string;
}

/** Candidate config files, in the order they are consulted. */
const CONFIG_FILES = [
  "esbuild.config.mjs",
  "esbuild.config.js",
  "esbuild.config.ts",
  "rollup.config.js",
  "rollup.config.mjs",
  "rollup.config.ts",
  "vite.config.ts",
  "vite.config.js",
];

/** Content of the config files we can read (missing files are skipped). */
export async function readConfigs(fs: Fs, projectDir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const name of CONFIG_FILES) {
    const text = await fs.readText(join(projectDir, name)).catch(() => undefined);
    if (typeof text === "string") found.set(name, text);
  }
  return found;
}

/**
 * Pull string literals out of an `entryPoints` / `input` declaration.
 *
 * Deliberately a text scan rather than module evaluation: evaluating a build
 * config would execute project code (and `dev` scripts enter watch mode), which
 * a tool call must never do.
 */
export function extractEntryCandidates(configText: string, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const declaration = new RegExp(`\\b${key}\\s*:\\s*([^\\n]*)`, "m").exec(configText);
    if (!declaration) continue;
    const line = declaration[1];
    for (const literal of line.matchAll(/["'`]([^"'`]+)["'`]/g)) {
      const value = literal[1];
      if (/\.(ts|tsx|js|mjs|cjs|jsx)$/.test(value)) out.push(value);
    }
  }
  return out;
}

/** Output paths declared by the build config (`outfile` / `file` / `dir`). */
export function extractOutputHints(configText: string): string[] {
  const out: string[] = [];
  for (const match of configText.matchAll(/\b(outfile|outdir|file|dir)\s*:\s*["'`]([^"'`]+)["'`]/g)) {
    out.push(match[2]);
  }
  return out;
}

/** Normalize a path found in config text to a project-relative path. */
function toProjectRelative(projectDir: string, value: string): string | undefined {
  const cleaned = value.replace(/^\.\//, "").replace(/^\/+/, "");
  if (cleaned === "" || isAbsolute(value)) return undefined;
  // `dir: '.'` means the project root itself.
  return cleaned === "." ? "" : cleaned;
}

/**
 * Resolve the plugin entry point.
 *
 * Order (DESIGN.md §4.1): explicit argument → `src/main.ts` → root `main.ts` →
 * the project's own bundler config → `package.json` main → a failure that
 * lists every candidate tried.
 */
export async function resolveEntry(
  fs: Fs,
  projectDir: string,
  options: { entry?: string } = {},
): Promise<{ ok: true; resolution: EntryResolution } | { ok: false; failure: EntryFailure }> {
  const tried: string[] = [];

  const accept = async (candidate: string, source: EntrySource): Promise<EntryResolution | undefined> => {
    const abs = isAbsolute(candidate) ? candidate : join(projectDir, candidate);
    if (!(await fs.exists(abs))) return undefined;
    return { path: abs, displayPath: relative(projectDir, abs) || candidate, source };
  };

  if (options.entry) {
    tried.push(options.entry);
    const hit = await accept(options.entry, "argument");
    if (hit) return { ok: true, resolution: hit };
    return { ok: false, failure: { header: `entry "${options.entry}" does not exist`, tried } };
  }

  for (const candidate of ["src/main.ts", "main.ts"]) {
    tried.push(candidate);
    const hit = await accept(candidate, candidate === "src/main.ts" ? "src/main.ts" : "main.ts");
    if (hit) return { ok: true, resolution: hit };
  }

  const configs = await readConfigs(fs, projectDir);
  const sources: Array<[string, string[], EntrySource]> = [
    ["esbuild.config.mjs", ["entryPoints"], "esbuild config"],
    ["esbuild.config.js", ["entryPoints"], "esbuild config"],
    ["esbuild.config.ts", ["entryPoints"], "esbuild config"],
    ["rollup.config.mjs", ["input"], "rollup config"],
    ["rollup.config.js", ["input"], "rollup config"],
    ["rollup.config.ts", ["input"], "rollup config"],
    ["vite.config.ts", ["input"], "vite config"],
    ["vite.config.js", ["input"], "vite config"],
  ];
  for (const [file, keys, source] of sources) {
    const text = configs.get(file);
    if (!text) continue;
    for (const candidate of extractEntryCandidates(text, keys)) {
      tried.push(`${file}: ${candidate}`);
      const hit = await accept(candidate, source);
      if (hit) return { ok: true, resolution: hit };
    }
  }

  const pkg = await fs.readJson(join(projectDir, "package.json"));
  if (typeof pkg?.main === "string" && /\.(ts|tsx|js|mjs|cjs)$/.test(pkg.main)) {
    tried.push(`package.json main: ${pkg.main}`);
    const hit = await accept(pkg.main, "package.json main");
    if (hit) return { ok: true, resolution: hit };
  }

  return {
    ok: false,
    failure: {
      header: "entry point not found",
      tried: tried.length ? tried : ["src/main.ts", "main.ts", "(no bundler config found)"],
    },
  };
}

// ---- artifact discovery ----------------------------------------------------

export type ArtifactSource =
  | "project root"
  | "bundler config"
  | "convention directory"
  | "search";

export interface ArtifactResolution {
  /** Absolute path of main.js. */
  path: string;
  /** Directory containing the built artifacts. */
  dir: string;
  source: ArtifactSource;
  /** How it was found, for the report. */
  detail: string;
}

/** Directories that are never worth searching for build output. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".obsidian",
  "src",
  "test",
  "tests",
  "__tests__",
  "docs",
  "dist",
  "build-tools",
]);

/**
 * Resolve where the built `main.js` lives.
 *
 * Order (DESIGN.md §4.1): project root → the config's declared output → the
 * conventional plugin directory inside the project → a bounded search. The last
 * resort exists because real projects legitimately output into their own test
 * vault, whose directory name is arbitrary.
 */
export async function resolveArtifact(
  fs: Fs,
  projectDir: string,
  options: { pluginId?: string } = {},
): Promise<{ ok: true; resolution: ArtifactResolution } | { ok: false; tried: string[] }> {
  const tried: string[] = [];
  const check = async (dir: string, source: ArtifactSource, detail: string): Promise<ArtifactResolution | undefined> => {
    const main = join(dir, "main.js");
    if (await fs.exists(main)) return { path: main, dir, source, detail };
    return undefined;
  };

  const root = await check(projectDir, "project root", "project root");
  if (root) return { ok: true, resolution: root };
  tried.push("main.js (project root)");

  const configs = await readConfigs(fs, projectDir);
  const hints: string[] = [];
  for (const [file, text] of configs) {
    for (const hint of extractOutputHints(text)) {
      const rel = toProjectRelative(projectDir, hint);
      if (rel === undefined) continue;
      hints.push(rel);
      const dir = rel === "" ? projectDir : join(projectDir, rel);
      tried.push(`${join(rel, "main.js")} (from ${file})`);
      const hit = await check(dir, "bundler config", `${file}: ${hint}`);
      if (hit) return { ok: true, resolution: hit };
    }
  }

  // Some configs build straight into the vault: `<something>/.obsidian/plugins/<id>/`.
  for (const hint of hints) {
    if (!hint.includes(".obsidian")) continue;
    const dir = join(projectDir, hint);
    const detail = `config output inside a vault (${hint})`;
    if (!tried.includes(detail)) tried.push(detail);
    const hit = await check(dir, "bundler config", detail);
    if (hit) return { ok: true, resolution: hit };
  }

  if (options.pluginId) {
    const conventional = join(projectDir, ".obsidian", "plugins", options.pluginId);
    tried.push(join(".obsidian", "plugins", options.pluginId, "main.js"));
    const hit = await check(conventional, "convention directory", "project-local .obsidian/plugins/<id>");
    if (hit) return { ok: true, resolution: hit };
  }

  const found = await searchForMain(fs, projectDir, 4, options.pluginId);
  for (const dir of found) {
    tried.push(`${relative(projectDir, dir)}/main.js`);
    const hit = await check(dir, "search", `found by search: ${relative(projectDir, dir) || "."}`);
    if (hit) return { ok: true, resolution: hit };
  }

  return { ok: false, tried };
}

/**
 * Breadth-first bounded search for a directory holding built artifacts.
 *
 * Each visited directory is probed two ways: `main.js` directly, and the
 * Obsidian vault layout `<dir>/.obsidian/plugins/<id>/main.js`. The second probe
 * matters because real plugins build straight into their own test vault
 * (editing-toolbar, dataview — DESIGN.md §2.8), and `.obsidian` is otherwise
 * skipped as a hidden directory.
 */
async function searchForMain(fs: Fs, root: string, maxDepth: number, pluginId?: string): Promise<string[]> {
  const hits: string[] = [];
  let level = [root];
  for (let depth = 0; depth < maxDepth && level.length && hits.length === 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      const entries = await fs.listDir(dir);
      if (entries.includes("main.js")) hits.push(dir);

      const vaultPlugins = join(dir, ".obsidian", "plugins");
      if (await fs.isDirectory(vaultPlugins)) {
        const ids = pluginId ? [pluginId] : await fs.listDir(vaultPlugins);
        for (const id of ids) {
          const candidate = join(vaultPlugins, id);
          if (await fs.exists(join(candidate, "main.js"))) hits.push(candidate);
        }
      }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
        const child = join(dir, entry);
        if (await fs.isDirectory(child)) next.push(child);
      }
    }
    level = next;
  }
  return hits;
}

/** Render a resolution failure so the caller can act without guessing. */
export function renderLookupFailure(kind: "entry" | "artifact", failure: { header?: string; tried: string[]; projectDir?: string }): string {
  const lines = [`Error: ${failure.header ?? `${kind} not found`}.`];
  if (failure.tried.length) {
    lines.push(`Tried (relative to ${failure.projectDir ?? "the project"}):`);
    for (const candidate of failure.tried) lines.push(`  - ${candidate}`);
  }
  lines.push(
    kind === "entry"
      ? 'Pass entry="<path>" explicitly if the entry point lives somewhere unusual.'
      : 'Pass outDir="<dir>" explicitly if the build output lives somewhere unusual, or check that the build actually ran.',
  );
  return lines.join("\n");
}

export { dirname };
