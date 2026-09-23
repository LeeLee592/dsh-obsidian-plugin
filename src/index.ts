import { join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readBundleDoc } from "./bundle-doc.js";
import { Fs, readAsset, type FsCall } from "./fs.js";
import { buildPlugin } from "./build.js";
import { deployPlugin } from "./deploy.js";
import { resolveArtifact } from "./lookup.js";
import { inspect } from "./inspect.js";
import { vaultAction } from "./vault.js";
import { reloadPlugin } from "./reload.js";
import { testPlugin } from "./harness.js";
import { e2eAction } from "./e2e.js";
import { evalInApp, focusWarning } from "./eval.js";
import {
  isSemver,
  namingProblems,
  render,
  toClassName,
  toPluginId,
  type Vars,
} from "./naming.js";

// ---- plugin identity ------------------------------------------------------

export const name = "obsidian-plugin";
export const inject = ["tools", "fs"];

export const Config = z.object({
  defaultMinAppVersion: z.string().default("1.13.0"),
});

// Re-exported for consumers that imported these from the package root.
export { Fs, type FsCall } from "./fs.js";
export { namingProblems, render, toClassName, toPluginId, isSemver } from "./naming.js";
export { buildPlugin, renderBuildReport, type BuildArgs, type BuildReport } from "./build.js";
export {
  BINDING_FILE,
  DEFAULT_VAULT_DIR,
  deployPlugin,
  renderVaultReport,
  resolveVault,
  type Binding,
  type DeployArgs,
  type VaultReport,
} from "./deploy.js";
export { classify, runCli, explainCliFailure, type CliResult, type CliStatus } from "./cli.js";
export { inspect, truncate, type InspectAction, type InspectArgs } from "./inspect.js";
export { vaultAction, registryPath, readRegistry, type VaultAction, type VaultArgs } from "./vault.js";
export { reloadPlugin, type ReloadAction, type ReloadArgs } from "./reload.js";
export { testPlugin, parseHarnessOutput, renderSmokeReport, type TestArgs } from "./harness.js";
export { e2eAction, renderTemplate, pluginDirFor, type E2eAction, type E2eArgs } from "./e2e.js";
export { evalInApp, focusWarning, type EvalArgs } from "./eval.js";

// ---- version notes / HARNESS context (external doc/ shipped with the package) ----

export interface VersionNote {
  version: string;
  date: string;
  zh: { title: string; items: string[] };
  en: { title: string; items: string[] };
}

function loadVersionNotes(): VersionNote[] {
  try {
    return JSON.parse(readBundleDoc("version-notes.json", "[]"));
  } catch {
    return [];
  }
}

export const VERSION_NOTES: VersionNote[] = loadVersionNotes();

export function getVersionNotes(lang: "zh" | "en" = "zh"): string {
  if (VERSION_NOTES.length === 0) return "（无版本说明 / no version notes）";
  return VERSION_NOTES.map((n) => {
    const t = n[lang] ?? n.zh;
    return `${n.version} (${n.date}) ${t.title}\n${t.items.map((i) => `  - ${i}`).join("\n")}`;
  }).join("\n\n");
}

const HARNESS_FALLBACK =
  "# HARNESS · 会话上下文\n你带「Obsidian 插件开发」能力：obsidian_plugin_scaffold / build / deploy / test / e2e / inspect / vault / reload / eval / validate / version（共 11 个工具）。" +
  "\n默认循环走 L1+L2+L4 不切用户窗口；改了界面必须真正看到（e2e 或 inspect screenshot），test 的 PASS 不等于 UI 已验收。";

export const HARNESS_CONTEXT = readBundleDoc("harness.default.md", HARNESS_FALLBACK);

// ---- template files (vendored from obsidianmd/obsidian-sample-plugin) ----

const TEMPLATE_FILES = [
  ".editorconfig",
  ".gitignore",
  ".npmrc",
  "LICENSE",
  "esbuild.config.mjs",
  "eslint.config.mts",
  "manifest.json",
  "package.json",
  "styles.css",
  "tsconfig.json",
  "version-bump.mjs",
  "versions.json",
  "src/main.ts",
  "src/settings.ts",
];

function readTemplate(fileName: string): string {
  return readAsset(`../assets/templates/${fileName}`);
}

// ---- skill registration ---------------------------------------------------
// The obsidian-plugin skill ships in assets/skills/ and is registered as a
// runtime skill during apply(), so it is available regardless of the caller's
// project root.

function readSkillFile(): string {
  return readAsset("../assets/skills/obsidian-plugin/SKILL.md");
}

function skillDir(): string {
  return fileURLToPath(new URL("../assets/skills/obsidian-plugin/", import.meta.url));
}

function parseSkill(md: string): { name: string; description: string; content: string } {
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md);
  if (!match) return { name: "obsidian-plugin", description: "", content: md };
  const front = match[1];
  const content = match[2].trimStart();
  const skillName = (/^name:\s*(.+)$/m.exec(front) ?? [])[1]?.trim() ?? "obsidian-plugin";
  const description = (/^description:\s*(.+)$/m.exec(front) ?? [])[1]?.trim() ?? "";
  return { name: skillName, description, content };
}

function registerSkill(ctx: any): void {
  const skills = ctx?.get?.("skills");
  if (typeof skills?.register !== "function") return;
  try {
    const { name: skillName, description, content } = parseSkill(readSkillFile());
    if (!skillName || !description) return;
    skills.register({
      name: skillName,
      description,
      content,
      source: "runtime",
      resourceBase: { kind: "directory", path: skillDir() },
    });
  } catch {
    // skill 注册失败不影响工具注册
  }
}

// ---- existing tool bodies -------------------------------------------------

interface ScaffoldArgs {
  targetDir: string;
  id: string;
  name: string;
  description?: string;
  author?: string;
  githubUser?: string;
  authorUrl?: string;
  minAppVersion?: string;
  version?: string;
}

export async function scaffold(fs: Fs, args: ScaffoldArgs, call: FsCall = {}): Promise<string> {
  const vars: Vars = {
    id: args.id,
    name: args.name,
    className: toClassName(args.name),
    description: args.description || "Enhance your workflow.",
    author: args.author || "You",
    authorUrl: args.authorUrl || (args.githubUser ? `https://github.com/${args.githubUser}` : ""),
    minAppVersion: args.minAppVersion || "1.13.0",
    version: args.version || "0.1.0",
    year: String(new Date().getFullYear()),
  };
  if (!isSemver(vars.version)) return `Error: version "${vars.version}" is not semver`;

  const naming = namingProblems(vars.id, vars.name, vars.description);
  if (naming.length) return "Error: metadata violates submission rules:\n- " + naming.join("\n- ");

  const target = await fs.resolve(args.targetDir, call.workspaceRoot);
  let created = 0;
  try {
    for (const file of TEMPLATE_FILES) {
      const dest = join(target, file);
      if (file === ".gitignore" || !(await fs.exists(dest))) {
        await fs.writeText(dest, render(readTemplate(file), vars), call.policy, call.signal);
        created++;
      }
    }
  } catch (error) {
    if ((error as any)?.code === "FS_SANDBOX_DENIED") {
      return `Error: cannot scaffold into "${target}" — it is outside the session workspace (sandbox mode "workspace-write" only allows writes under the workspace or temp dir). Use a targetDir inside the current workspace, or run with a wider sandbox mode.`;
    }
    throw error;
  }
  return `Scaffolded ${vars.id} into ${target} (${created} files). Next: cd ${args.targetDir} && pnpm install && pnpm run dev`;
}

export async function validateProject(fs: Fs, args: { projectDir: string }, call: FsCall = {}): Promise<string> {
  const dir = await fs.resolve(args.projectDir, call.workspaceRoot);
  const problems: string[] = [];
  const warnings: string[] = [];

  const manifest = await fs.readJson(join(dir, "manifest.json"));
  if (!manifest) return "Error: manifest.json not found or invalid JSON";
  for (const field of ["id", "name", "version", "minAppVersion", "description", "author"]) {
    if (typeof manifest[field] !== "string" || manifest[field].trim() === "") {
      problems.push(`manifest.json: missing/invalid required field "${field}"`);
    }
  }
  if (manifest.id && manifest.name && manifest.description) {
    const naming = namingProblems(manifest.id, manifest.name, manifest.description);
    problems.push(...naming.map((e) => `manifest.json: ${e}`));
    if (manifest.description.length > 250) warnings.push(`description is ${manifest.description.length} chars (recommended ≤ 250)`);
  }
  if (manifest.version && !isSemver(manifest.version)) problems.push(`manifest.json: version "${manifest.version}" is not semver`);

  const versions = await fs.readJson(join(dir, "versions.json"));
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    problems.push("versions.json: not found or invalid JSON object");
  } else if (manifest.version && versions[manifest.version] !== manifest.minAppVersion) {
    problems.push(`versions.json: expected { "${manifest.version}": "${manifest.minAppVersion}" }, got "${versions[manifest.version]}"`);
  }

  const pkg = await fs.readJson(join(dir, "package.json"));
  if (!pkg) problems.push("package.json: not found or invalid JSON");
  else if (manifest.version && pkg.version !== manifest.version) problems.push(`package.json: version "${pkg.version}" != manifest "${manifest.version}"`);

  // eslint-plugin-obsidianmd 检查（借用项目自身的 eslint 环境）
  const eslintBin = join(dir, "node_modules", ".bin", "eslint");
  if (await fs.exists(eslintBin)) {
    const { run } = await import("./proc.js");
    const result = run({ command: eslintBin, args: ["."], cwd: dir, timeoutMs: 180_000 });
    if (result.reason === "spawn-error") {
      warnings.push(`eslint could not run: ${result.errorMessage ?? "unknown error"}`);
    } else if (result.reason === "timeout") {
      warnings.push("eslint timed out after 180s — skipped");
    } else if (!result.ok) {
      problems.push(`eslint (eslint-plugin-obsidianmd):\n${result.output}`);
    }
  } else {
    warnings.push("eslint not available — run `pnpm install` in the plugin project first to enable eslint-plugin-obsidianmd checks");
  }

  if (problems.length === 0) {
    const w = warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : "";
    return `OK: id=${manifest.id} version=${manifest.version} minAppVersion=${manifest.minAppVersion}${w}`;
  }
  return "Validation failed:\n- " + problems.join("\n- ");
}

export async function bumpVersion(fs: Fs, args: { projectDir: string; version: string; minAppVersion?: string }, call: FsCall = {}): Promise<string> {
  const dir = await fs.resolve(args.projectDir, call.workspaceRoot);
  if (!isSemver(args.version)) return `Error: version "${args.version}" is not semver`;

  const manifestPath = join(dir, "manifest.json");
  const versionsPath = join(dir, "versions.json");
  const pkgPath = join(dir, "package.json");

  const manifest = await fs.readJson(manifestPath);
  const versions = await fs.readJson(versionsPath);
  const pkg = await fs.readJson(pkgPath);
  if (!manifest || !versions || !pkg) return "Error: manifest.json/versions.json/package.json must all exist and be valid JSON";

  const minAppVersion = args.minAppVersion || manifest.minAppVersion;
  manifest.version = args.version;
  if (args.minAppVersion) manifest.minAppVersion = args.minAppVersion;
  versions[args.version] = minAppVersion;
  pkg.version = args.version;

  try {
    await fs.writeText(manifestPath, JSON.stringify(manifest, null, 2) + "\n", call.policy, call.signal);
    await fs.writeText(versionsPath, JSON.stringify(versions, null, 2) + "\n", call.policy, call.signal);
    await fs.writeText(pkgPath, JSON.stringify(pkg, null, 2) + "\n", call.policy, call.signal);
  } catch (error) {
    if ((error as any)?.code === "FS_SANDBOX_DENIED") {
      return `Error: cannot write to "${dir}" — it is outside the session workspace (sandbox mode "workspace-write" only allows writes under the workspace or temp dir). Use a projectDir inside the current workspace, or run with a wider sandbox mode.`;
    }
    throw error;
  }

  return `Bumped to ${args.version} (minAppVersion ${minAppVersion}). Remember to git add manifest.json versions.json package.json`;
}

// ---- Cordis plugin entry --------------------------------------------------

const textOutput = {
  schema: { type: "string" as const },
  render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }],
};

export function apply(ctx: any, config: any) {
  const fs = new Fs(ctx?.fs);
  const cfg = (config ?? {}) as { defaultMinAppVersion?: string };

  registerSkill(ctx);

  function makeCall(exec: any): FsCall {
    const session = exec?.agent?.session;
    const policy = ctx?.get?.("sandboxPolicy")?.resolve?.(session ? { session } : {});
    return {
      workspaceRoot: policy?.workspaceRoot ?? session?.header?.cwd,
      policy,
      signal: exec?.signal,
    };
  }

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_scaffold",
    description: "Generate a submission-ready Obsidian plugin skeleton from the official obsidian-sample-plugin template (src/main.ts, src/settings.ts, manifest.json, esbuild/eslint configs, versions.json, LICENSE, and more). Validates id/name/description against Obsidian submission rules.",
    parameters: {
      targetDir: { type: "string", required: true, description: "Directory (absolute or workspace-relative) to scaffold into." },
      id: { type: "string", required: true, description: "Plugin id: lowercase letters/digits/dashes/underscores, no 'obsidian', not ending with 'plugin'." },
      name: { type: "string", required: true, description: "Plugin name: no 'Obsidian', not ending with 'Plugin'." },
      description: { type: "string", description: "One-line description ending with . ? ! or )." },
      author: { type: "string", description: "Author name." },
      githubUser: { type: "string", description: "Optional GitHub username (auto-generates authorUrl)." },
      authorUrl: { type: "string", description: "Optional explicit author URL." },
      minAppVersion: { type: "string", description: "Minimum Obsidian version, e.g. 1.13.0." },
      version: { type: "string", description: "Initial semver version, e.g. 0.1.0." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      return scaffold(fs, { ...args, minAppVersion: args.minAppVersion ?? cfg.defaultMinAppVersion }, makeCall(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_build",
    description: "Bundle an Obsidian plugin project into a loadable main.js (CommonJS, obsidian externalized) and run static self-checks: artifact presence, module format and export, manifest/versions/package version consistency. Use it after editing src/ and before deploying. It performs one-shot builds only — never a watch process.",
    parameters: {
      projectDir: { type: "string", required: true, description: "Plugin project directory (absolute or workspace-relative)." },
      production: { type: "boolean", description: "Report the build as production (default true). Note: when the project has its own esbuild.config.mjs, the project's own flags decide the actual output, so this is a reporting hint rather than a guarantee." },
      entry: { type: "string", description: "Explicit entry file (e.g. 'main.ts' or 'src/plugin/main.ts'). Omit to auto-detect: src/main.ts, root main.ts, the project's bundler config, then package.json main." },
      outDir: { type: "string", description: "Explicit directory holding the built main.js. Omit to auto-detect: project root, the bundler config's output, .obsidian/plugins/<id>/, then a bounded search." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      return buildPlugin(fs, args, makeCall(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_deploy",
    description: "Install built artifacts (main.js, manifest.json, styles.css) into a vault's .obsidian/plugins/<id>/ and add the id to that vault's community-plugins.json, then remember the vault in dsh.obsidian.json. Reports the three states separately: files written, enabled in the vault list, and whether the running app loaded it — this step installs files only, so activation is verified with obsidian_plugin_reload plus obsidian_plugin_inspect.",
    parameters: {
      projectDir: { type: "string", required: true, description: "Plugin project directory (absolute or workspace-relative)." },
      vault: { type: "string", description: "Target vault directory. Omit to reuse the dsh.obsidian.json binding, then the TestVault/ convention next to the project." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      return deployPlugin(fs, args, makeCall(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_inspect",
    description: "Read-only observation of the running Obsidian app: status (one-shot health report: live app version, registered vaults, active vault, restricted mode, whether the target plugin is installed/enabled, version drift, pending trust modal), errors, console (attaches and detaches the capture debugger), dom, css, screenshot, trustCheck. It never changes the app. Window-scoped readings follow the active window, so status reports which vault actually answered and warns on a mismatch.",
    parameters: {
      action: { type: "string", required: true, description: "status | errors | console | dom | css | screenshot | trustCheck" },
      projectDir: { type: "string", description: "Plugin project directory; status uses its manifest.json to check the installed/enabled/version state." },
      vault: { type: "string", description: "Target vault name or path used to address the CLI (window-scoped commands still follow the active window)." },
      selector: { type: "string", description: "dom/css: CSS selector." },
      what: { type: "string", description: "dom: text | attr | total | all | inner (default text)." },
      attr: { type: "string", description: "dom: attribute name when what=attr." },
      prop: { type: "string", description: "css: property to read." },
      level: { type: "string", description: "console: log | warn | error | info | debug." },
      limit: { type: "number", description: "console: max messages (default 50)." },
      path: { type: "string", description: "screenshot: absolute output path inside the workspace." },
      clear: { type: "boolean", description: "errors/console: clear the buffer after reading." },
      keepDebugger: { type: "boolean", description: "console: leave the capture debugger attached (read it later, but plugin:reload will hang until it is detached)." },
      all: { type: "boolean", description: "status: list every registered vault instead of just counting them." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      return inspect(fs, args, makeCall(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_vault",
    description: "Manage the vault used for live verification. status reports registered vaults, the active window and what activation would take. ensure WITHOUT confirm only describes the consequences; with confirm=true it registers/opens the vault (Obsidian switches to the front) and then verifies, reporting Obsidian's trust modal instead of accepting it. close closes the test window (macOS). Use it before any window-scoped command so the readings hit the right vault.",
    parameters: {
      action: { type: "string", required: true, description: "status | ensure | close | prune" },
      vault: { type: "string", description: "Target vault: absolute path, or a vault name registered with Obsidian." },
      confirm: { type: "boolean", description: "Required for ensure to actually open/register the vault, and for any destructive action." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      return vaultAction(fs, args, makeCall(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_reload",
    description: "Make a code change take effect in the running Obsidian app: reload (plugin:reload), enable, or disable a plugin. After reloading it verifies that the plugin is actually registered in the app and reports anything the plugin logged — a command that was accepted is not the same as a plugin that loaded. Requires the target vault to be the active window (use obsidian_plugin_vault action=ensure first).",
    parameters: {
      projectDir: { type: "string", description: "Plugin project directory; the plugin id is read from its manifest.json." },
      pluginId: { type: "string", description: "Plugin id; overrides projectDir lookup." },
      vault: { type: "string", description: "Target vault name used to address the CLI." },
      action: { type: "string", description: "reload (default) | enable | disable | rescan | unrestrict. rescan refreshes the plugin index (Obsidian only scans at vault load, so a freshly deployed plugin is invisible without it); unrestrict turns OFF restricted mode for this vault (a security setting, reloads the window)." },
      verify: { type: "boolean", description: "Confirm the plugin is registered afterwards (default true)." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      const call = makeCall(exec);
      return reloadPlugin(args, {
        cli: { signal: call.signal },
        workspaceRoot: call.workspaceRoot,
        readManifestId: async (projectDir: string) => {
          const dir = await fs.resolve(projectDir, call.workspaceRoot);
          const manifest = await fs.readJson(join(dir, "manifest.json"));
          return typeof manifest?.id === "string" ? manifest.id : undefined;
        },
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_test",
    description: "Offline smoke test (L2): loads the built bundle in plain Node against a stubbed Obsidian API and exercises the real lifecycle — default export is a Plugin subclass, onload() runs, registrations happen, onunload() cleans up, no unhandled rejections. Runs without any Obsidian installed, so use it as the floor that catches 'crashes on load'. It does NOT verify runtime behaviour: the report always says it is a stub environment and points at inspect/e2e for real verification.",
    parameters: {
      projectDir: { type: "string", required: true, description: "Plugin project directory (absolute or workspace-relative)." },
      bundle: { type: "string", description: "Explicit main.js path; omit to auto-detect (same chain as obsidian_plugin_build)." },
      scenario: { type: "string", description: "Optional project scenario module (e.g. dsh/scenarios/example.mjs) that gets { plugin, app, stub } to assert behaviour offline." },
      timeoutMs: { type: "number", description: "Harness timeout in ms (default 120000)." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      return testPlugin(fs, args, makeCall(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_e2e",
    description: "Scaffold sandboxed end-to-end tests (L4) — the verification tier that does NOT touch your Obsidian. It generates a WebdriverIO + wdio-obsidian-service setup that launches its own Obsidian with an isolated config directory and a copy of the vault, so nothing switches your window or steals focus. Use it to remove the window-switching that live CLI checks cause. It scaffolds and reports; it never runs the suite for you (run `pnpm run e2e`).",
    parameters: {
      action: { type: "string", required: true, description: "init (write the scaffold) | status (report what exists, what is missing)" },
      projectDir: { type: "string", required: true, description: "Plugin project directory (absolute or workspace-relative)." },
      dir: { type: "string", description: "Scaffold directory inside the project (default 'e2e')." },
      force: { type: "boolean", description: "Overwrite generated files that already exist (default false)." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      const call = makeCall(exec);
      const projectDir = await fs.resolve(args.projectDir, call.workspaceRoot);
      const manifest = await fs.readJson(join(projectDir, "manifest.json"));
      // Point the sandbox at wherever this project actually builds.
      const artifact = await resolveArtifact(fs, projectDir, { pluginId: manifest?.id });
      return e2eAction(fs, args, call, artifact.ok ? artifact.resolution.dir : undefined);
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_eval",
    description: "Run JavaScript inside the running Obsidian app and return the result — the live-state escape hatch. Use it to read what the app really holds (plugin instances, workspace, metadataCache), to drive an interaction, or to try a fix without rebuilding. This is the only high-privilege tool: it executes code in the user's app, so it is approval-gated and the executed code is echoed back in the result. Prefer obsidian_plugin_inspect (free, no approval) whenever a read-only action can answer the question.",
    parameters: {
      code: { type: "string", required: true, description: "JavaScript to evaluate in the app context, for example Object.keys(app.plugins.plugins). It runs as-is, so keep it side-effect free unless the task needs otherwise; the executed code is echoed back in the result." },
      vault: { type: "string", description: "Target vault name to address the CLI; window-scoped like every plugin/dev command." },
      timeoutMs: { type: "number", description: "Timeout in ms for long expressions (default 30000)." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      const call = makeCall(exec);
      return evalInApp(args, { signal: call.signal });
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_validate",
    description: "Validate an Obsidian plugin: manifest required fields, submission naming rules (id/name/description), versions.json mapping, package.json version consistency, and eslint-plugin-obsidianmd lint checks.",
    parameters: {
      projectDir: { type: "string", required: true, description: "Plugin project directory (absolute or workspace-relative)." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      return validateProject(fs, args, makeCall(exec));
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_plugin_version",
    description: "Bump an Obsidian plugin version consistently across manifest.json, versions.json, and package.json.",
    parameters: {
      projectDir: { type: "string", required: true, description: "Plugin project directory (absolute or workspace-relative)." },
      version: { type: "string", required: true, description: "New semver version, e.g. 1.1.0." },
      minAppVersion: { type: "string", description: "Optional new minimum Obsidian version." },
    },
    output: textOutput,
    async execute(args: any, exec: any) {
      return bumpVersion(fs, args, makeCall(exec));
    },
  }));
}
