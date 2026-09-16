// Obsidian submission naming rules and template placeholder rendering.
//
// Extracted from index.ts so the guardrails can be reused by build/deploy
// without importing the tool registrations.

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function isSemver(version: string): boolean {
  return SEMVER.test(version);
}

export interface Vars {
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

/**
 * Obsidian community-plugin submission rules, enforced identically by
 * `obsidian_plugin_scaffold`, `obsidian_plugin_validate` and (as a warning)
 * `obsidian_plugin_build`.
 */
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
