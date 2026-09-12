import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readBundleDoc } from "./bundle-doc.js";

// ---- plugin identity ------------------------------------------------------

export const name = "dsh-obsidian-plugin";
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
  "# HARNESS · 会话上下文\n你带「Obsidian 插件开发」能力：obsidian_scaffold / obsidian_validate / obsidian_version。";

export const HARNESS_CONTEXT = readBundleDoc("harness.default.md", HARNESS_FALLBACK);

// ---- filesystem seam ------------------------------------------------------
// `ctx.fs` is injected by the harness (sandboxed/observable). It is optional so
// the smoke tests can run in bare Node; in that case we fall back to node:fs.

export class Fs {
  constructor(private fs?: any) {}
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
  async writeText(path: string, content: string): Promise<void> {
    if (this.fs) {
      await this.fs.writeText(await this.fs.resolve(path), content);
      return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf8");
  }
}

// ---- embedded templates (kept in sync with packages/skill/obsidian-plugin-dev/assets/templates) ----
// Based on gapmiss/obsidian-plugin-skill (MIT).

const TEMPLATES: Record<string, string> = {
  "src/main.ts": `import { Plugin } from 'obsidian';
import { PluginSettings, SettingsTab, DEFAULT_SETTINGS } from './settings';

export default class {{PLUGIN_CLASS}}Plugin extends Plugin {
	settings: PluginSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Add settings tab
		this.addSettingTab(new SettingsTab(this.app, this));

		// Register commands
		this.addCommand({
			id: 'run-example',
			name: 'Run example',
			callback: () => {
				// TODO: Implement your command
			}
		});
	}

	onunload(): void {
		// Cleanup handled automatically by Obsidian
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<PluginSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
`,
  "src/settings.ts": `import { App, PluginSettingTab } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type {{PLUGIN_CLASS}}Plugin from './main';

export interface PluginSettings {
	exampleSetting: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	exampleSetting: 'default'
};

export class SettingsTab extends PluginSettingTab {
	plugin: {{PLUGIN_CLASS}}Plugin;

	constructor(app: App, plugin: {{PLUGIN_CLASS}}Plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Example setting',
				desc: 'This is an example setting',
				control: {
					type: 'text',
					key: 'exampleSetting',
					placeholder: 'Enter value'
				}
			}
		];
	}
}
`,
  "manifest.json": `{
  "id": "{{PLUGIN_ID}}",
  "name": "{{PLUGIN_NAME}}",
  "version": "{{PLUGIN_VERSION}}",
  "minAppVersion": "{{MIN_APP_VERSION}}",
  "description": "{{PLUGIN_DESCRIPTION}}",
  "author": "{{PLUGIN_AUTHOR}}",
  "authorUrl": "{{AUTHOR_URL}}",
  "isDesktopOnly": false
}
`,
  "styles.css": `/*
 * Styles for {{PLUGIN_ID}}
 *
 * Best practices:
 * - Use Obsidian CSS variables for all styling
 * - Scope all selectors to plugin containers
 * - Support both light and dark themes via CSS variables
 * - Follow Obsidian's 4px spacing grid (var(--size-4-*))
 */
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "inlineSourceMap": true,
    "inlineSources": true,
    "module": "ESNext",
    "target": "ES6",
    "allowJs": true,
    "noImplicitAny": true,
    "moduleResolution": "bundler",
    "importHelpers": true,
    "isolatedModules": true,
    "strictNullChecks": true,
    "lib": ["DOM", "ES5", "ES6", "ES7"]
  },
  "include": ["src/**/*.ts"]
}
`,
  "package.json": `{
  "name": "{{PLUGIN_ID}}",
  "version": "{{PLUGIN_VERSION}}",
  "description": "{{PLUGIN_DESCRIPTION}}",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "lint": "eslint src/",
    "version": "node version-bump.mjs && git add manifest.json versions.json"
  },
  "keywords": ["obsidian", "obsidian-plugin"],
  "author": "{{PLUGIN_AUTHOR}}",
  "license": "MIT",
  "devDependencies": {
    "@eslint/js": "^9.30.1",
    "@eslint/json": "^0.14.0",
    "@types/node": "^22.15.17",
    "esbuild": "^0.28.1",
    "eslint": "^9.30.1",
    "eslint-plugin-obsidianmd": "^0.4.1",
    "jiti": "^2.6.1",
    "obsidian": "latest",
    "tslib": "^2.4.0",
    "typescript": "^5.9.2",
    "typescript-eslint": "^8.35.1"
  },
  "allowScripts": {
    "esbuild": true
  }
}
`,
  "esbuild.config.mjs": `import esbuild from "esbuild";
import process from "process";
import { builtinModules } from "node:module";

const banner =
\`/*
THIS IS A GENERATED/BUNDLED FILE BY ESBUILD
if you want to view the source, please visit the github repository of this plugin
*/
\`;

const prod = (process.argv[2] === "production");

const context = await esbuild.context({
	banner: {
		js: banner,
	},
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
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
		...builtinModules],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
`,
  "eslint.config.mjs": `import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
    { ignores: ["node_modules/**", "main.js", "*.mjs"] },
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: "./tsconfig.json",
                sourceType: "module",
            },
        },
    },
]);
`,
  "version-bump.mjs": `import { readFileSync, writeFileSync } from "fs";

const targetVersion = process.env.npm_package_version;

let manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\\t"));

let versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\\t"));
`,
  "versions.json": `{
  "{{PLUGIN_VERSION}}": "{{MIN_APP_VERSION}}"
}
`,
  ".gitignore": `# Logs
*.log
npm-debug.log*

# Dependency directories
node_modules/

# Build output
main.js
*.js.map

# OS files
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/

# TypeScript cache
*.tsbuildinfo

# Privacy
data.json
.env
`,
  "LICENSE": `MIT License

Copyright (c) {{YEAR}} {{PLUGIN_AUTHOR}}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`,
};

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

function resolveDir(p: string): string {
  return resolve(process.cwd(), p);
}

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

export async function scaffold(fs: Fs, args: ScaffoldArgs): Promise<string> {
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

  const target = resolveDir(args.targetDir);
  let created = 0;
  for (const [file, template] of Object.entries(TEMPLATES)) {
    const dest = join(target, file);
    if (file === ".gitignore" || !(await fs.exists(dest))) {
      await fs.writeText(dest, render(template, vars));
      created++;
    }
  }
  return `Scaffolded ${vars.id} into ${target} (${created} files). Next: cd ${args.targetDir} && npm install && npm run dev`;
}

export async function validateProject(fs: Fs, args: { projectDir: string }): Promise<string> {
  const dir = resolveDir(args.projectDir);
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

  if (problems.length === 0) {
    const w = warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : "";
    return `OK: id=${manifest.id} version=${manifest.version} minAppVersion=${manifest.minAppVersion}${w}`;
  }
  return "Validation failed:\n- " + problems.join("\n- ");
}

export async function bumpVersion(fs: Fs, args: { projectDir: string; version: string; minAppVersion?: string }): Promise<string> {
  const dir = resolveDir(args.projectDir);
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

  await fs.writeText(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await fs.writeText(versionsPath, JSON.stringify(versions, null, 2) + "\n");
  await fs.writeText(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

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

  ctx.tools.register(defineTool({
    name: "obsidian_scaffold",
    description: "Generate a submission-ready Obsidian plugin skeleton (src/main.ts, src/settings.ts with declarative settings, manifest.json, esbuild/eslint configs, version-bump, versions.json, LICENSE, .gitignore). Validates id/name/description against Obsidian submission rules.",
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
    async execute(args: any) {
      return scaffold(fs, { ...args, minAppVersion: args.minAppVersion ?? cfg.defaultMinAppVersion });
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_validate",
    description: "Validate an Obsidian plugin: manifest required fields, submission naming rules (id/name/description), versions.json mapping, and package.json version consistency.",
    parameters: {
      projectDir: { type: "string", required: true, description: "Plugin project directory (absolute or workspace-relative)." },
    },
    output: textOutput,
    async execute(args: any) {
      return validateProject(fs, args);
    },
  }));

  ctx.tools.register(defineTool({
    name: "obsidian_version",
    description: "Bump an Obsidian plugin version consistently across manifest.json, versions.json, and package.json.",
    parameters: {
      projectDir: { type: "string", required: true, description: "Plugin project directory (absolute or workspace-relative)." },
      version: { type: "string", required: true, description: "New semver version, e.g. 1.1.0." },
      minAppVersion: { type: "string", description: "Optional new minimum Obsidian version." },
    },
    output: textOutput,
    async execute(args: any) {
      return bumpVersion(fs, args);
    },
  }));
}
