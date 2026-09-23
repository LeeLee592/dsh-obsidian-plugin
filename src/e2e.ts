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
  /** Vault the sandbox opens (copied before use), relative to the project. */
  vaultDir: string;
}

/** Render the `{{...}}` placeholders used by the shipped templates. */
export function renderTemplate(template: string, vars: E2eVars): string {
  return template
    .split("{{PLUGIN_ID}}").join(vars.pluginId)
    .split("{{PLUGIN_NAME}}").join(vars.pluginName)
    .split("{{PLUGIN_DIR}}").join(vars.pluginDir)
    .split("{{VAULT_DIR}}").join(vars.vaultDir);
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

/** A project-relative path in the "./x/y" form the generated config expects. */
export function posixRel(from: string, to: string): string {
  const rel = relative(from, to).split("\\").join("/");
  if (rel === "" || rel === ".") return ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

/** Directory names that look like a throwaway test vault rather than real notes. */
const TEST_VAULT_NAMES = ["test", "testvault", "test-vault", "test vault", "sandbox", "e2e", "dev", "example"];

/** Directories never worth scanning for a vault. */
const IGNORED_DIRS = new Set(["node_modules", ".git", ".obsidian", ".obsidian-cache", ".e2e-obsidian", "dist", "build", "coverage"]);

/** A vault is any directory holding a `.obsidian` folder. */
async function isVault(fs: Fs, dir: string, call: FsCall): Promise<boolean> {
  return await fs.isDirectory(join(dir, ".obsidian"), call.workspaceRoot);
}

/**
 * Find a test vault already in the project, or decide to create one.
 *
 * Why this exists: the config's vault path used to be a hardcoded `./e2e/vault`
 * that nothing ever created, so a freshly scaffolded project failed its very
 * first `pnpm run e2e` in onPrepare with `Vault "…" doesn't exist`. A scaffold
 * that does not run as generated is a defect, not a setup step.
 *
 * A vault that exists is preferred over an invented one because it is what the
 * developer actually opens the plugin against. Candidates are ranked so that a
 * directory named like a test vault wins over a folder of real notes, and
 * `mdCount` is reported so the caller can warn instead of silently copying a
 * personal vault.
 */
export async function findVault(
  fs: Fs,
  projectDir: string,
  scaffoldDir: string,
  call: FsCall = {},
): Promise<{ dir: string; existing: boolean; mdCount: number }> {
  const entries = await fs.listDir(projectDir, call.workspaceRoot);
  const candidates: Array<{ dir: string; mdCount: number; named: boolean }> = [];
  for (const name of entries) {
    if (name.startsWith(".") || IGNORED_DIRS.has(name)) continue;
    if (join(projectDir, name) === scaffoldDir) continue;
    const dir = join(projectDir, name);
    if (!(await isVault(fs, dir, call))) continue;
    const md = (await fs.listDir(dir, call.workspaceRoot)).filter((f) => f.endsWith(".md")).length;
    candidates.push({ dir, mdCount: md, named: TEST_VAULT_NAMES.includes(name.toLowerCase()) });
  }
  if (candidates.length === 0) return { dir: join(scaffoldDir, "vault"), existing: false, mdCount: 0 };
  candidates.sort((a, b) => Number(b.named) - Number(a.named) || a.mdCount - b.mdCount);
  return { dir: candidates[0].dir, existing: true, mdCount: candidates[0].mdCount };
}

export async function e2eAction(fs: Fs, args: E2eArgs, call: FsCall = {}, artifactDir?: string): Promise<string> {
  const action: E2eAction = args.action ?? "init";
  if (action === "status") return await status(fs, args, call);
  return await init(fs, args, call, artifactDir);
}

/**
 * Facts a generated config must carry, each with the failure it prevents.
 *
 * Why a drift check exists at all: a scaffold is generated once and then lives in
 * the project forever, while this template keeps learning. A real session ran the
 * pre-0.8.1 config thirteen times and every run flashed an Obsidian window on
 * screen — the file was "there", so nothing suggested it was out of date.
 */
const REQUIRED_CONFIG_FACTS: Array<{ test: RegExp; label: string; why: string }> = [
  {
    test: /"wdio:obsidianOptions"/,
    label: 'Obsidian options are a capability key ("wdio:obsidianOptions")',
    why: "as service options they are ignored and Obsidian starts without the plugin, failing as \"executeObsidian is not a function\"",
  },
  { test: /services:\s*\["obsidian"\]/, label: 'services: ["obsidian"]', why: "the service entry takes no options object" },
  { test: /--no-sandbox/, label: "--no-sandbox on the capability", why: "Chromium's helpers abort at startup inside a nested sandbox" },
  {
    // NOT a chrome flag: none of --headless, --headless=new or --hidden hides
    // the window (all verified), because Obsidian shows its own window during
    // bootstrap. Hiding it from inside the app is what works.
    test: /hide\(\)/,
    label: "a `before` hook that hides the instance window",
    why: "no chrome/electron flag suppresses the window; without this hook it stays on screen for the whole run",
  },
  { test: /copy:\s*true/, label: "copy: true", why: "the vault must be opened as a copy, never in place" },
  { test: /plugins:/, label: "plugins: [...]", why: "the sandbox needs to install the plugin under test" },
];

/** Report which required facts a project's existing config is missing. */
export function configDrift(configText: string): string[] {
  return REQUIRED_CONFIG_FACTS.filter((fact) => !fact.test.test(configText)).map((fact) => `${fact.label} — ${fact.why}`);
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

  // A config that exists is not necessarily a config that works.
  const configPath = join(projectDir, "wdio.conf.mts");
  const configText = (await fs.readText(configPath).catch(() => undefined)) ?? undefined;
  const drift = configText === undefined ? [] : configDrift(configText);

  // Vault existence is a hard prerequisite: when it is missing the service aborts
  // in onPrepare, before a single spec runs.
  const vaultPath = /const E2E_VAULT\s*=\s*"([^"]+)"/.exec(configText ?? "")?.[1];
  const vaultLine = vaultPath === undefined
    ? "  vault:    unknown — no E2E_VAULT in wdio.conf.mts"
    : (await fs.isDirectory(join(projectDir, vaultPath), call.workspaceRoot))
      ? `  vault:    ${vaultPath} (present; copied per run)`
      : `  vault:    ${vaultPath} MISSING — every run will fail in onPrepare ("Vault ... doesn't exist"); run action=init`;

  return [
    `Sandboxed E2E for ${manifest.id}`,
    `  scaffold: ${files.map(([r]) => r).join(", ")} under ${dir}`,
    ...present.map((line) => `    - ${line}`),
    `  scripts:  e2e ${scripts.e2e ? "present" : "missing"} · e2e:watch ${scripts["e2e:watch"] ? "present" : "missing"}`,
    missing.length ? `  deps:     missing ${missing.join(", ")} — run: pnpm add -D ${missing.join(" ")}` : "  deps:     all present",
    drift.length
      ? `  config:   OUT OF DATE — ${drift.length} required setting(s) missing:\n${drift.map((d) => `              · ${d}`).join("\n")}\n            run action=init force=true to refresh wdio.conf.mts (your specs are kept)`
      : configText === undefined
        ? "  config:   not scaffolded yet — run action=init"
        : "  config:   up to date",
    vaultLine,
    "Note: this tier downloads its own Obsidian into an isolated config directory and works on a copy of the vault, so your own Obsidian is never switched or focused.",
  ].join("\n");
}

async function init(fs: Fs, args: E2eArgs, call: FsCall, artifactDir?: string): Promise<string> {
  const projectDir = await fs.resolve(args.projectDir, call.workspaceRoot);
  const manifest = await fs.readJson(join(projectDir, "manifest.json"));
  if (!manifest?.id) return 'Error: manifest.json not found, invalid JSON, or missing a string "id".';

  const specsDir = join(projectDir, args.dir ?? "e2e");
  // The config's vault must exist before the first run, or the service aborts in
  // onPrepare. Prefer a vault the project already has; create an empty one if not.
  const vault = await findVault(fs, projectDir, specsDir, call);
  const vars: E2eVars = {
    pluginId: manifest.id,
    pluginName: manifest.name ?? manifest.id,
    pluginDir: pluginDirFor(projectDir, artifactDir ?? join(projectDir, "main.js")),
    vaultDir: posixRel(projectDir, vault.dir),
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
  const denied = (error: unknown) => (error as { code?: string })?.code === "FS_SANDBOX_DENIED" || (error as { code?: string })?.code === "EPERM";
  try {
  for (const [target, template] of rendered) {
    const label = relative(projectDir, target);
    if ((await fs.exists(target)) && !args.force) {
      skipped.push(label);
      continue;
    }
    await fs.writeText(target, renderTemplate(template, vars), call.policy, call.signal);
    written.push(label);
  }

  // A config whose vault path does not exist fails before the first spec, so the
  // vault is part of the scaffold, not something the developer is left to notice.
  if (!vault.existing) {
    await fs.mkdir(join(vault.dir, ".obsidian"), call.policy, call.signal);
    // A marker the generated .gitignore un-ignores, so the vault directory
    // itself survives a clone. Without it the first run on a fresh checkout
    // fails in onPrepare exactly like the original defect.
    await fs.writeText(join(vault.dir, ".gitkeep"), "", call.policy, call.signal);
    written.push(`${posixRel(projectDir, vault.dir)}/ (empty test vault)`);
  }
  } catch (error) {
    if (denied(error)) {
      return [
        `Error: cannot write the E2E scaffold into "${projectDir}" — it is outside the session workspace`,
        'and sandbox mode "workspace-write" only allows writes under the workspace or the temp dir.',
        "Options:",
        "  1) Apply the change by hand — see the required settings below",
        "  2) Re-run with a wider sandbox mode and approve the prompt",
        "Required settings for wdio.conf.mts (a config missing any of these fails or interferes):",
        ...REQUIRED_CONFIG_FACTS.map((f) => `  · ${f.label} — ${f.why}`),
      ].join("\n");
    }
    throw error;
  }

  // The sandbox downloads Obsidian builds and copies the vault; keep that out of git.
  let gitignoreNote = ".gitignore already ignores e2e artifacts";
  let addedScripts: string[] = [];
  let scripts: Record<string, string> = {};
  let missingDeps: string[] = [];
  let pkg: Record<string, unknown> = {};
  try {
  const gitignorePath = join(projectDir, ".gitignore");
  const existing = (await fs.readText(gitignorePath).catch(() => "")) ?? "";
  const block = readAsset("../assets/e2e/gitignore.e2e").trimStart();
  if (!existing.includes(".e2e-obsidian/")) {
    const separator = existing.endsWith("\n") || existing === "" ? "" : "\n";
    await fs.writeText(gitignorePath, `${existing}${separator}\n${block}`, call.policy, call.signal);
    gitignoreNote = "added the e2e artifacts to .gitignore";
  }

  // Wire the scripts, preserving everything already there.
  pkg = (await fs.readJson(join(projectDir, "package.json"))) ?? {};
  scripts = { ...(pkg.scripts ?? {}) } as Record<string, string>;
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
  } catch (error) {
    if (denied(error)) {
      return [
        `Error: cannot update "${projectDir}/.gitignore" or package.json — the project is outside the session workspace`,
        "The E2E files themselves were written; add these yourself:",
        `  · .gitignore: ${readAsset("../assets/e2e/gitignore.e2e").trim().split("\n").join(" / ")}`,
        '  · package.json scripts: "e2e": "wdio run ./wdio.conf.mts"',
      ].join("\n");
    }
    throw error;
  }

  const devDeps = { ...(pkg.devDependencies ?? {}) } as Record<string, string>;
  missingDeps = E2E_DEV_DEPS.filter((dep) => !(dep in devDeps));

  const lines = [
    `Scaffolded sandboxed E2E for ${manifest.id}`,
    `  wrote:    ${written.length ? written.join(", ") : "(nothing new)"}`,
  ];
  if (skipped.length) lines.push(`  kept:     ${skipped.join(", ")} (already present; pass force=true to overwrite)`);
  if (skipped.includes("wdio.conf.mts")) {
    const existing = (await fs.readText(join(projectDir, "wdio.conf.mts")).catch(() => undefined)) ?? "";
    const drift = configDrift(existing);
    if (drift.length) {
      lines.push(
        `  ! the kept wdio.conf.mts is OUT OF DATE — ${drift.length} required setting(s) missing:`,
        ...drift.map((d) => `      · ${d}`),
        "    run action=init force=true to refresh it (your specs are not touched)",
      );
    }
  }
  lines.push(
    `  plugin:   the sandbox installs from "${vars.pluginDir}" — build before running`,
    `  scripts:  ${addedScripts.length ? `added ${addedScripts.join(", ")}` : "e2e scripts already present"}`,
    `  ${gitignoreNote}`,
  );
  lines.push(
    vault.existing
      ? `  vault:    ${vars.vaultDir} (a vault already in the project; copied per run, so tests never write to it)`
      : `  vault:    ${vars.vaultDir} (created empty — no test vault existed in the project)`,
  );
  // Copying is safe but not silent: a vault full of notes is the wrong thing to
  // point tests at, and the developer should decide that, not the scaffold.
  if (vault.existing && vault.mdCount > 20) {
    lines.push(
      `  ! that vault has ${vault.mdCount} notes at its root — if it is your real vault, point E2E_VAULT in`,
      "    wdio.conf.mts at a purpose-built test vault instead (tests still only ever read a copy)",
    );
  }
  if (missingDeps.length) {
    lines.push(`  deps:     install the test runner:\n            pnpm add -D ${missingDeps.join(" ")}`);
  } else {
    lines.push("  deps:     all present");
  }
  lines.push(
    "",
    "Why this is the default verification tier: the sandbox is a separate Obsidian",
    "with its own config directory and a copy of the vault, and the generated",
    "config hides that instance's window before any spec runs — so nothing",
    "switches, focuses or shows your own Obsidian while it runs. (Its own window",
    "still exists for about a second during startup: no launch flag suppresses it,",
    "because Obsidian shows the window itself. `e2e:watch` pays that cost once.)",
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
