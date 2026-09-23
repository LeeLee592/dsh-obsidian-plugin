// obsidian_plugin_deploy — install built artifacts into a vault.
//
// Scope (DESIGN.md §4.2): the offline path. Files are written and the vault's
// enable list is updated here; whether the running app then loads the plugin is
// a separate, explicit step — obsidian_plugin_reload (rescan/enable) and
// obsidian_plugin_inspect (status) answer that, and this tool points at them
// rather than importing the Obsidian CLI into a file-installation path.
//
// The three states are reported separately and never conflated:
//
//   written  — artifacts are on disk in the vault
//   enabled  — the id is present in the vault's community-plugins.json
//   active   — the running app actually loaded the plugin (not knowable here)
//
// "written" must never be reported as "working".

import { Buffer } from "node:buffer";
import { join } from "node:path";
import type { Fs, FsCall } from "./fs.js";

export const BINDING_FILE = "dsh.obsidian.json";
export const DEFAULT_VAULT_DIR = "TestVault";

/** Artifacts every community plugin ships. styles.css is optional. */
const REQUIRED_ARTIFACTS = ["main.js", "manifest.json"] as const;
const OPTIONAL_ARTIFACTS = ["styles.css"] as const;

export interface DeployArgs {
  projectDir: string;
  /** Absolute path, or a vault directory inside the workspace. Omit to use the binding / convention. */
  vault?: string;
}

export interface Binding {
  version: 1;
  vault: string;
  pluginId: string;
  lastDeploy: {
    at: string;
    files: string[];
    enabled: boolean;
    active: boolean | "unknown";
    trust: "not-required" | "granted" | "pending" | "unknown";
  };
}

export type VaultSource = "argument" | "binding" | "convention";

export interface VaultResolution {
  vault: string;
  source: VaultSource;
}

/**
 * Resolve the target vault without inventing one.
 *
 * Order: explicit argument → project binding → in-workspace convention
 * directory. When none matches we fail with the options instead of creating a
 * vault the user did not ask for.
 */
export async function resolveVault(
  fs: Fs,
  projectDir: string,
  args: DeployArgs,
  call: FsCall = {},
): Promise<{ ok: true; resolution: VaultResolution } | { ok: false; message: string }> {
  if (args.vault) {
    const vault = await fs.resolve(args.vault, call.workspaceRoot);
    if (!(await fs.isDirectory(vault, call.workspaceRoot))) {
      return { ok: false, message: `Error: vault directory not found: ${vault}` };
    }
    if (!(await looksLikeVault(fs, vault))) {
      return { ok: false, message: notAVaultMessage(vault) };
    }
    return { ok: true, resolution: { vault, source: "argument" } };
  }

  const bindingPath = join(projectDir, BINDING_FILE);
  const binding = await fs.readJson(bindingPath);
  if (binding?.vault) {
    if ((await fs.isDirectory(binding.vault)) && (await looksLikeVault(fs, binding.vault, call.workspaceRoot))) {
      return { ok: true, resolution: { vault: binding.vault, source: "binding" } };
    }
  }

  const conventional = await fs.resolve(DEFAULT_VAULT_DIR, projectDir);
  if ((await fs.isDirectory(conventional)) && (await looksLikeVault(fs, conventional, call.workspaceRoot))) {
    return { ok: true, resolution: { vault: conventional, source: "convention" } };
  }

  return {
    ok: false,
    message: [
      "Error: no target vault resolved.",
      `Tried: the vault argument, ${BINDING_FILE}, and ${DEFAULT_VAULT_DIR}/ next to the plugin.`,
      "Options:",
      `  1) Create a test vault inside the project (${DEFAULT_VAULT_DIR}/) and pass vault="<path>" once — it is remembered in ${BINDING_FILE}`,
      "  2) Pass vault=<absolute path to an existing vault>",
      "  3) For a vault outside the session workspace, re-run with a wider sandbox mode.",
    ].join("\n"),
  };
}

async function looksLikeVault(fs: Fs, dir: string, workspaceRoot?: string): Promise<boolean> {
  const abs = await fs.resolve(dir, workspaceRoot);
  return (
    (await fs.isDirectory(join(abs, ".obsidian"))) || (await fs.exists(join(abs, ".obsidian", "app.json")))
  );
}

function notAVaultMessage(dir: string): string {
  return [
    `Error: "${dir}" does not look like a vault (no .obsidian directory).`,
    `Create the directory "${dir}/.obsidian" and open the folder once in Obsidian, or point vault= at an existing vault.`,
  ].join("\n");
}

export interface VaultReport {
  ok: boolean;
  pluginId?: string;
  version?: string;
  vault?: string;
  vaultSource?: VaultSource;
  written: string[];
  enabled: boolean;
  missing: string[];
  failures: string[];
  warnings: string[];
}

export function renderVaultReport(report: VaultReport, text = ""): string {
  if (!report.ok) {
    const body = report.failures.length ? report.failures.join("\n") : text;
    return body || "Deploy failed.";
  }
  const lines = [
    `Deployed ${report.pluginId} ${report.version} → ${report.vault}`,
    `  vault:   resolved via ${report.vaultSource}`,
    `  files:   written (${report.written.join(" · ")})`,
    `  enabled: ${report.enabled ? "yes (id present in community-plugins.json)" : "no"}`,
    "  active:  unknown — files are installed; the running app has not been asked",
    "Note: this step only writes files. Verify that the plugin actually loads with",
    "      obsidian_plugin_reload (rescan after a first install, then enable) and read",
    "      the result back with obsidian_plugin_inspect action=status.", 
  ];
  for (const w of report.warnings) lines.push(`  ! ${w}`);
  lines.push(
    `Next: obsidian_plugin_reload action=rescan (Obsidian only scans .obsidian/plugins at vault load, so a ` +
      "newly installed plugin is invisible without it), then action=enable. Both act on whichever vault is in " +
      `front, so confirm with obsidian_plugin_inspect action=status that "${report.vault}" is the vault that answered.`,
  );
  return lines.join("\n");
}

export async function deployPlugin(fs: Fs, args: DeployArgs, call: FsCall = {}): Promise<string> {
  const report: VaultReport = { ok: false, written: [], enabled: false, missing: [], failures: [], warnings: [] };

  const projectDir = await fs.resolve(args.projectDir, call.workspaceRoot);
  const manifest = await fs.readJson(join(projectDir, "manifest.json"));
  if (!manifest || typeof manifest.id !== "string" || manifest.id.trim() === "") {
    report.failures.push("manifest.json not found, invalid JSON, or missing a string \"id\"");
    return renderVaultReport(report);
  }
  report.pluginId = manifest.id;
  report.version = manifest.version;

  // ---- artifacts ------------------------------------------------------------
  for (const name of REQUIRED_ARTIFACTS) {
    if (!(await fs.exists(join(projectDir, name)))) report.missing.push(name);
  }
  if (report.missing.length) {
    return `Error: missing build artifact(s): ${report.missing.join(", ")}. Run obsidian_plugin_build first.`;
  }
  // Optional artifacts are only meaningful when they were present at build
  // time; a stale copy in the vault is worse than none, so record what we ship.
  const optional: string[] = [];
  for (const name of OPTIONAL_ARTIFACTS) {
    if (await fs.exists(join(projectDir, name))) optional.push(name);
  }
  const shipped = [...REQUIRED_ARTIFACTS, ...optional];

  // ---- vault ---------------------------------------------------------------
  const resolved = await resolveVault(fs, projectDir, args, call);
  if (!resolved.ok) return resolved.message;
  const { vault, source } = resolved.resolution;
  report.vault = vault;
  report.vaultSource = source;

  const pluginDir = join(vault, ".obsidian", "plugins", manifest.id);
  try {
    for (const name of shipped) {
      const content = await fs.readText(join(projectDir, name));
      await fs.writeText(join(pluginDir, name), content, call.policy, call.signal);
      report.written.push(`${name} (${(Buffer.byteLength(content) / 1024).toFixed(1)} KB)`);
    }
  } catch (error) {
    const code = (error as any)?.code;
    if (code === "FS_SANDBOX_DENIED") {
      return [
        `Error: cannot write into "${pluginDir}" — it is outside the session workspace`,
        '(sandbox mode "workspace-write" only allows writes under the workspace or the temp dir).',
        "Options:",
        `  1) Use a test vault inside the workspace: ${join(args.projectDir, DEFAULT_VAULT_DIR)}   ← recommended`,
        "  2) Re-run with a wider sandbox mode and approve the prompt",
        "  3) Deploy manually: copy main.js/manifest.json[/styles.css] into the vault and enable it in Settings → Community plugins",
      ].join("\n");
    }
    throw error;
  }

  // ---- enable list ---------------------------------------------------------
  // Obsidian only reads this file while the vault is closed; merging preserves
  // every other enabled plugin instead of clobbering the user's setup.
  const listPath = join(vault, ".obsidian", "community-plugins.json");
  const raw = await fs.readJson(listPath);
  const list: string[] = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  if (!raw) report.warnings.push("community-plugins.json was missing or malformed — created a new enable list");
  if (!list.includes(manifest.id)) {
    list.push(manifest.id);
    await fs.writeText(listPath, JSON.stringify(list, null, "\t") + "\n", call.policy, call.signal);
  }
  report.enabled = true;

  const stale = (await fs.listDir(pluginDir)).filter((f) => !shipped.includes(f) && f !== "data.json");
  if (stale.length) report.warnings.push(`leftover file(s) in the vault plugin dir: ${stale.join(", ")}`);

  // ---- binding -------------------------------------------------------------
  const binding: Binding = {
    version: 1,
    vault,
    pluginId: manifest.id,
    lastDeploy: {
      at: new Date().toISOString(),
      files: shipped,
      enabled: true,
      active: "unknown",
      trust: "unknown",
    },
  };
  try {
    await fs.writeText(
      join(projectDir, BINDING_FILE),
      JSON.stringify(binding, null, 2) + "\n",
      call.policy,
      call.signal,
    );
  } catch {
    report.warnings.push(`could not write ${BINDING_FILE}; the next deploy will need an explicit vault=`);
  }

  report.ok = true;
  return renderVaultReport(report);
}
