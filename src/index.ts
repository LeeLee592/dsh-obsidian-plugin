import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readBundleDoc } from "./bundle-doc.js";

// ---- plugin identity ------------------------------------------------------

export const name = "obsidian-plugin";
export const inject = ["tools", "fs"];

export const Config = z.object({
  defaultMinAppVersion: z.string().default("1.13.0"),
});

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
  "# HARNESS · 会话上下文\n你带「Obsidian 插件开发」能力：obsidian_plugin_scaffold / obsidian_plugin_validate / obsidian_plugin_version。";

export const HARNESS_CONTEXT = readBundleDoc("harness.default.md", HARNESS_FALLBACK);

// ---- filesystem seam ------------------------------------------------------
// `ctx.fs` is injected by the harness (sandboxed/observable). It is optional so
// the smoke tests can run in bare Node; in that case we fall back to node:fs.
//
// Every mutating call must carry the calling session's sandbox policy so the
// `dsh-fs-sandbox` backend fences against the *session* workspace, not the
// process-wide fallback root.

export interface FsCall {
  workspaceRoot?: string;
  policy?: any;
  signal?: AbortSignal;
}

export class Fs {
  constructor(private fs?: any) {}
  async resolve(path: string, workspaceRoot?: string): Promise<string> {
    if (this.fs) {
      const target = await this.fs.resolve(path, workspaceRoot === undefined ? undefined : { cwd: workspaceRoot });
      return target.displayPath;
    }
    return resolve(workspaceRoot ?? process.cwd(), path);
  }
  async exists(path: string): Promise<boolean> {
    if (this.fs) {
      try {
        const t = await this.fs.resolve(path);
        return (await this.fs.stat(t)) !== undefined;
      } catch {
        return false;
      }
    }
    return existsSync(path);
  }
  async readText(path: string): Promise<string> {
    if (this.fs) return await this.fs.readText(await this.fs.resolve(path));
    return readFile(path, "utf8");
  }
  async readJson(path: string): Promise<any | null> {
    try {
      return JSON.parse(await this.readText(path));
    } catch {
      return null;
    }
  }
  async writeText(path: string, content: string, policy?: any, signal?: AbortSignal): Promise<void> {
    if (this.fs) {
      const target = await this.fs.resolve(path);
      await this.fs.writeText(target, content, undefined, signal, policy);
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

// ---- template files (vendored from obsidianmd/obsidian-sample-plugin) ----
// Scaffold reads these from assets/templates/ and fills the {{...}} placeholders.

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
  const url = new URL(`../assets/templates/${fileName}`, import.meta.url);
  return readFileSync(url, "utf8").replace(/^\uFEFF/, "");
}


// ---- shared helpers -------------------------------------------------------

interface Vars {
  id: string;
  name: string;
  className: string;
  description: string;
  author: string;
  authorUrl: string;
  minAppVersion: string;
  version: string;
  year: string;
}

export function render(template: string, vars: Vars): string {
  return template
    .split("{{PLUGIN_ID}}").join(vars.id)
    .split("{{PLUGIN_NAME}}").join(vars.name)
    .split("{{PLUGIN_CLASS}}").join(vars.className)
    .split("{{PLUGIN_DESCRIPTION}}").join(vars.description)
    .split("{{PLUGIN_AUTHOR}}").join(vars.author)
    .split("{{AUTHOR_URL}}").join(vars.authorUrl)
    .split("{{MIN_APP_VERSION}}").join(vars.minAppVersion)
    .split("{{PLUGIN_VERSION}}").join(vars.version)
    .split("{{YEAR}}").join(vars.year);
}

export function toClassName(name: string): string {
  return name
    .split(/[\s-_]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
}

export function toPluginId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function namingProblems(id: string, name: string, description: string): string[] {
  const errors: string[] = [];
  if (/obsidian/i.test(id)) errors.push('id cannot contain "obsidian"');
  if (/plugin$/i.test(id)) errors.push('id cannot end with "plugin"');
  if (!/^[a-z0-9_-]+$/.test(id)) errors.push("id must only contain lowercase letters, numbers, dashes, underscores");
  if (/obsidian/i.test(name)) errors.push('name cannot contain "Obsidian"');
  if (/plugin$/i.test(name)) errors.push('name cannot end with "Plugin"');
  if (/^obsi/i.test(name) || /dian$/i.test(name)) errors.push('name cannot start with "Obsi" or end with "dian"');
  if (/obsidian/i.test(description)) errors.push('description cannot include "Obsidian"');
  if (/this plugin|this is a plugin|this plugin allows/i.test(description)) errors.push('description cannot use "This plugin" phrases');
  if (!/[.?!)]$/.test(description)) errors.push("description must end with punctuation . ? ! or )");
  return errors;
}

// ---- tool bodies ----------------------------------------------------------

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
  if (!SEMVER.test(vars.version)) return `Error: version "${vars.version}" is not semver`;

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
  if (manifest.version && !SEMVER.test(manifest.version)) problems.push(`manifest.json: version "${manifest.version}" is not semver`);

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
    const result = spawnSync(eslintBin, ["."], { cwd: dir, encoding: "utf8" });
    if (result.error) {
      warnings.push(`eslint could not run: ${result.error.message}`);
    } else if (result.status !== 0) {
      const output = (result.stdout || "").trim() || (result.stderr || "").trim();
      problems.push(`eslint (eslint-plugin-obsidianmd):\n${output}`);
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
  if (!SEMVER.test(args.version)) return `Error: version "${args.version}" is not semver`;

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
