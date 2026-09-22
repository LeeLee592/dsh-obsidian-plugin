// obsidian_plugin_e2e — scaffold sandboxed end-to-end tests (L4, DESIGN.md §4.4).
//
// Why this tier exists: `plugin:*` / `dev:*` / `eval` resolve against the active
// window, so verifying anything live via the CLI means bringing the test vault to
// the front — which switches the user's window and steals their focus. That cost
// is real (it makes Obsidian unusable for anything else while the agent works),
// and it is OUR choice: `vault-open` is the only command that switches windows.
//
// The fix is not "switch less", it is to stop needing the user's Obsidian at all.
// wdio-obsidian-service launches its own Obsidian with an isolated user
// configuration directory and a copy of the vault, driven over CDP. So this tool
// scaffolds that setup; it does not reimplement the framework, and it does not
// add its dependencies to our package.

import { isAbsolute, join, relative } from "node:path";
import { readAsset } from "./fs.js";
import type { Fs, FsCall } from "./fs.js";

export type E2eAction = "init" | "status";

export interface E2eArgs {
  projectDir: string;
  action?: E2eAction;
  /** Scaffold into this directory, relative to the project (default "e2e"). */
  dir?: string;
  /** Overwrite generated files that already exist. */
  force?: boolean;
}

/** Package names the generated setup expects the project to install. */
const E2E_DEV_DEPS = ["@wdio/cli", "@wdio/local-runner", "@wdio/mocha-framework", "@wdio/spec-reporter", "@wdio/globals", "@wdio/types", "wdio-obsidian-service", "typescript"];

interface E2eVars {
  pluginId: string;
  pluginName: string;
  /** Directory the built main.js lands in, relative to the project. */
  pluginDir: string;
}

/** Render the `{{...}}` placeholders used by the shipped templates. */
export function renderTemplate(template: string, vars: E2eVars): string {
  return template
    .split("{{PLUGIN_ID}}").join(vars.pluginId)
    .split("{{PLUGIN_NAME}}").join(vars.pluginName)
    .split("{{PLUGIN_DIR}}").join(vars.pluginDir);
}

/**
 * Where the sandbox's plugin install should read built artifacts from.
 *
 * Relative when the artifacts live inside the project (the common case), and the
 * untouched absolute path when they do not — decided by path containment rather
 * than string prefixing, so a sibling directory with a shared prefix is not
 * mistaken for a child.
 */
export function pluginDirFor(projectDir: string, artifactDir: string): string {
  const rel = relative(projectDir, artifactDir);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return artifactDir;
  return rel.split("\\").join("/");
}

export async function e2eAction(fs: Fs, args: E2eArgs, call: FsCall = {}, artifactDir?: string): Promise<string> {
  const action: E2eAction = args.action ?? "init";
  if (action === "status") return await status(fs, args, call);
  return await init(fs, args, call, artifactDir);
}

async function status(fs: Fs, args: E2eArgs, call: FsCall): Promise<string> {
  const projectDir = await fs.resolve(args.projectDir, call.workspaceRoot);
  const dir = join(projectDir, args.dir ?? "e2e");
  const manifest = await fs.readJson(join(projectDir, "manifest.json"));
  if (!manifest?.id) return 'Error: manifest.json not found, invalid JSON, or missing a string "id".';

  const files = [
    ["wdio.conf.mts", join(projectDir, "wdio.conf.mts")],
    ["tsconfig.e2e.json", join(projectDir, "tsconfig.e2e.json")],
    ["specs/example.e2e.ts", join(dir, "specs", "example.e2e.ts")],
  ] as const;
  const present = [];
  for (const [rel, path] of files) present.push(`${rel}: ${(await fs.exists(path)) ? "present" : "missing"}`);

  const pkg = await fs.readJson(join(projectDir, "package.json"));
  const scripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const devDeps = { ...(pkg?.devDependencies ?? {}) } as Record<string, string>;
  const missing = E2E_DEV_DEPS.filter((dep) => !(dep in devDeps));

  return [
    `Sandboxed E2E for ${manifest.id}`,
    `  scaffold: ${files.map(([r]) => r).join(", ")} under ${dir}`,
    ...present.map((line) => `    - ${line}`),
    `  scripts:  e2e ${scripts.e2e ? "present" : "missing"} · e2e:watch ${scripts["e2e:watch"] ? "present" : "missing"}`,
    missing.length ? `  deps:     missing ${missing.join(", ")} — run: pnpm add -D ${missing.join(" ")}` : "  deps:     all present",
    "Note: this tier downloads its own Obsidian into an isolated config directory and works on a copy of the vault, so your own Obsidian is never switched or focused.",
  ].join("\n");
}

async function init(fs: Fs, args: E2eArgs, call: FsCall, artifactDir?: string): Promise<string> {
  const projectDir = await fs.resolve(args.projectDir, call.workspaceRoot);
  const manifest = await fs.readJson(join(projectDir, "manifest.json"));
  if (!manifest?.id) return 'Error: manifest.json not found, invalid JSON, or missing a string "id".';

  const specsDir = join(projectDir, args.dir ?? "e2e");
  const vars: E2eVars = {
    pluginId: manifest.id,
    pluginName: manifest.name ?? manifest.id,
    pluginDir: pluginDirFor(projectDir, artifactDir ?? join(projectDir, "main.js")),
  };

  // `wdio run` resolves its config from the project root, so the config lives
  // there and only the specs/vault live under the scaffold directory. Putting the
  // config inside `e2e/` makes the very first `pnpm run e2e` fail with
  // "missing configuration".
  const rendered: Array<[string, string]> = [
    [join(projectDir, "wdio.conf.mts"), readAsset("../assets/e2e/wdio.conf.mts")],
    [join(projectDir, "tsconfig.e2e.json"), readAsset("../assets/e2e/tsconfig.e2e.json")],
    [join(specsDir, "specs", "example.e2e.ts"), readAsset("../assets/e2e/example.e2e.ts")],
  ];

  const written: string[] = [];
  const skipped: string[] = [];
  for (const [target, template] of rendered) {
    const label = relative(projectDir, target);
    if ((await fs.exists(target)) && !args.force) {
      skipped.push(label);
      continue;
    }
    await fs.writeText(target, renderTemplate(template, vars), call.policy, call.signal);
    written.push(label);
  }

  // The sandbox downloads Obsidian builds and copies the vault; keep that out of git.
  const gitignorePath = join(projectDir, ".gitignore");
  const existing = (await fs.readText(gitignorePath).catch(() => "")) ?? "";
  const block = readAsset("../assets/e2e/gitignore.e2e").trimStart();
  let gitignoreNote = ".gitignore already ignores e2e artifacts";
  if (!existing.includes(".e2e-obsidian/")) {
    const separator = existing.endsWith("\n") || existing === "" ? "" : "\n";
    await fs.writeText(gitignorePath, `${existing}${separator}\n${block}`, call.policy, call.signal);
    gitignoreNote = "added the e2e artifacts to .gitignore";
  }

  // Wire the scripts, preserving everything already there.
  const pkg = (await fs.readJson(join(projectDir, "package.json"))) ?? {};
  const scripts = { ...(pkg.scripts ?? {}) } as Record<string, string>;
  const addedScripts: string[] = [];
  if (!scripts.e2e) {
    scripts.e2e = "wdio run ./wdio.conf.mts";
    addedScripts.push("e2e");
  }
  if (!scripts["e2e:watch"]) {
    scripts["e2e:watch"] = "wdio run ./wdio.conf.mts --watch";
    addedScripts.push("e2e:watch");
  }
  if (addedScripts.length) {
    pkg.scripts = scripts;
    await fs.writeText(join(projectDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", call.policy, call.signal);
  }

  const devDeps = { ...(pkg.devDependencies ?? {}) } as Record<string, string>;
  const missingDeps = E2E_DEV_DEPS.filter((dep) => !(dep in devDeps));

  const lines = [
    `Scaffolded sandboxed E2E for ${manifest.id}`,
    `  wrote:    ${written.length ? written.join(", ") : "(nothing new)"}`,
  ];
  if (skipped.length) lines.push(`  kept:     ${skipped.join(", ")} (already present; pass force=true to overwrite)`);
  lines.push(
    `  plugin:   the sandbox installs from "${vars.pluginDir}" — build before running`,
    `  scripts:  ${addedScripts.length ? `added ${addedScripts.join(", ")}` : "e2e scripts already present"}`,
    `  ${gitignoreNote}`,
  );
  if (missingDeps.length) {
    lines.push(`  deps:     install the test runner:\n            pnpm add -D ${missingDeps.join(" ")}`);
  } else {
    lines.push("  deps:     all present");
  }
  lines.push(
    "",
    "Why this is the default verification tier: the sandbox is a separate Obsidian",
    "with its own config directory, a copy of the vault and a headless window, so",
    "nothing switches, focuses or even briefly shows your Obsidian while it runs.",
    "",
    "First run downloads its own Obsidian (tens of MB) into ./.obsidian-cache and",
    "reuses it afterwards. On a slow connection that download can exceed the",
    "runner's own body timeout and fail with UND_ERR_BODY_TIMEOUT — just run it",
    "again; the cache is kept, so progress is not lost. For offline or CI use,",
    "pre-seed the cache and point at it with cacheDir / OBSIDIAN_CACHE.",
    "",
    `Next: pnpm run build && pnpm run e2e`,
  );
  return lines.join("\n");
}
