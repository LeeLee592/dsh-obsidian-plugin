// P2c tests: the sandboxed-E2E scaffold.
//
// The tier exists to stop the user's Obsidian from being switched and focused,
// so the assertions cover both what gets generated and the promise that it is
// non-destructive to the project.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fs } from "../lib/fs.js";
import { e2eAction, pluginDirFor, renderTemplate } from "../lib/e2e.js";

const fs = new Fs();

async function project(extra: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "p2c-"));
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ id: "demo-notes", name: "Demo Notes", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" }),
  );
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "demo-notes", scripts: { build: "echo build" }, ...extra }, null, 2));
  await writeFile(join(dir, "main.js"), "module.exports = {};\n");
  return dir;
}

test("renderTemplate substitutes the plugin identity", () => {
  const out = renderTemplate("id={{PLUGIN_ID}} name={{PLUGIN_NAME}} dir={{PLUGIN_DIR}}", {
    pluginId: "demo-notes",
    pluginName: "Demo Notes",
    pluginDir: ".",
  });
  assert.equal(out, "id=demo-notes name=Demo Notes dir=.");
});

test("pluginDirFor turns the artifact directory into a project-relative path", () => {
  assert.equal(pluginDirFor("/p", "/p"), ".", "the project root is '.'");
  assert.equal(pluginDirFor("/p", "/p/TestVault/.obsidian/plugins/x"), "TestVault/.obsidian/plugins/x");
  assert.equal(pluginDirFor("/p", "/elsewhere/x"), "/elsewhere/x", "outside the project stays absolute");
});

test("status reports what is missing instead of writing anything", async () => {
  const dir = await project();
  try {
    const out = await e2eAction(fs, { action: "status", projectDir: dir });
    assert.match(out, /Sandboxed E2E for demo-notes/);
    assert.match(out, /wdio\.conf\.mts: missing/);
    assert.match(out, /scripts: {2}e2e missing/);
    assert.match(out, /deps: {5}missing [^\n]*wdio-obsidian-service/);
    assert.match(out, /pnpm add -D/);
    assert.match(out, /never switched or focused/);
    assert.equal(await fs.exists(join(dir, "wdio.conf.mts")), false, "status must not write");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init writes the scaffold, wires scripts and keeps the project's own entries", async () => {
  const dir = await project({ scripts: { build: "echo build", test: "echo test" } });
  try {
    const out = await e2eAction(fs, { action: "init", projectDir: dir }, {}, join(dir, "TestVault", ".obsidian", "plugins", "demo-notes"));
    assert.match(out, /Scaffolded sandboxed E2E for demo-notes/);

    const conf = await readFile(join(dir, "wdio.conf.mts"), "utf8");
    // The shape is load-bearing: Obsidian options must sit under the capability
    // key, or the service silently starts an app without the plugin installed.
    assert.match(conf, /"wdio:obsidianOptions"/, "Obsidian options belong to the capability");
    assert.match(conf, /services: \["obsidian"\]/, "the service entry is the bare name");
    assert.doesNotMatch(conf, /services: \[\s*\[/, "the service must not take an options array");
    assert.match(conf, /plugins: \["\."\]/, "the sandbox installs the project itself");
    assert.match(conf, /copy: true/, "the vault is opened as a copy");
    // The window suppression was found the hard way, and the wrong answer is
    // the intuitive one: no chrome/electron flag hides the window, so pin BOTH
    // that no flag is claimed to do it and that the hook which does is present.
    assert.match(conf, /--no-sandbox/, "nested sandboxes make Chromium helpers abort");
    // Check the real args, not the prose: the comment names the ineffective
    // switches on purpose, so scanning the whole file would fail on the
    // explanation. A visibility flag in the actual args is the regression.
    const args = /"goog:chromeOptions": \{ args: \[([^\]]*)\]/.exec(conf)?.[1] ?? "";
    assert.equal(args.replace(/[\s"']/g, ""), "--no-sandbox", "only --no-sandbox belongs in the args; no flag hides the window");
    assert.match(conf, /before: async function/, "window hiding needs a hook");
    assert.match(conf, /getAllWindows\(\)\) w\.hide\(\)/, "the hook must actually hide the window");
    assert.match(conf, /executeObsidian.*NOT available|NOT available yet at this point/i, "and record why the raw execute is required");
    assert.match(conf, /e2e:watch/, "the per-run startup window is mitigated, and the mitigation is named");
    assert.doesNotMatch(conf, /reporters: \["obsidian"\]/, "that reporter needs an unlisted package");
    assert.doesNotMatch(conf, /\{\{/, "no placeholder may survive");

    const spec = await readFile(join(dir, "e2e", "specs", "example.e2e.ts"), "utf8");
    assert.match(spec, /demo-notes/);
    assert.doesNotMatch(spec, /\{\{/);

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.scripts.e2e, "wdio run ./wdio.conf.mts");
    assert.equal(pkg.scripts["e2e:watch"], "wdio run ./wdio.conf.mts --watch");
    assert.equal(pkg.scripts.build, "echo build", "existing scripts survive");
    assert.equal(pkg.scripts.test, "echo test");

    const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    assert.match(gitignore, /\.e2e-obsidian\//, "downloaded builds stay out of git");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init is idempotent: existing files are kept unless force is set", async () => {
  const dir = await project();
  try {
    await e2eAction(fs, { action: "init", projectDir: dir });
    const target = join(dir, "wdio.conf.mts");
    await writeFile(target, "// customised by hand\n");

    const kept = await e2eAction(fs, { action: "init", projectDir: dir });
    assert.match(kept, /kept: {5}wdio\.conf\.mts/);
    assert.equal(await readFile(target, "utf8"), "// customised by hand\n");

    const forced = await e2eAction(fs, { action: "init", projectDir: dir, force: true });
    assert.doesNotMatch(forced, /kept:/);
    assert.match(await readFile(target, "utf8"), /wdio-obsidian-service/);

    const second = await e2eAction(fs, { action: "init", projectDir: dir, force: true });
    assert.match(second, /e2e scripts already present/, "scripts are not duplicated");
    const gitignore = await readFile(join(dir, ".gitignore"), "utf8");
    assert.equal(gitignore.split(".e2e-obsidian/").length - 1, 1, "the gitignore block is not appended twice");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the generated config documents why the tier exists", async () => {
  const dir = await project();
  try {
    await e2eAction(fs, { action: "init", projectDir: dir });
    const conf = await readFile(join(dir, "wdio.conf.mts"), "utf8");
    assert.match(conf, /switch windows and steal/i);
    assert.match(conf, /creates and shows its own\s*\/\/ window|creates and shows its own/i, "why no flag works is explained, not just asserted");
    assert.match(conf, /isolated user-configuration directory/);
    assert.match(conf, /copy: true/, "the sandbox must work on a copy of the vault");
    assert.match(conf, /earliest/, "minAppVersion is the default version under test");
    assert.match(conf, /UND_ERR_BODY_TIMEOUT|obsidian-cache/, "the first-run download is documented");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status and init report a config that predates a required setting", async () => {
  const dir = await project();
  try {
    // A config written before window hiding existed: plausible, present, and it
    // flashes a window on every run. Nothing else in the tool would notice.
    await writeFile(
      join(dir, "wdio.conf.mts"),
      [
        'const config = {',
        '  services: ["obsidian"],',
        '  capabilities: [{ browserName: "obsidian", "goog:chromeOptions": { args: ["--no-sandbox"] }, "wdio:obsidianOptions": { vault: "./e2e/vault", copy: true, plugins: ["."] } }],',
        '};',
        'export { config };',
      ].join("\n"),
    );

    const out = await e2eAction(fs, { action: "status", projectDir: dir });
    assert.match(out, /config:\s+OUT OF DATE/);
    assert.match(out, /before` hook that hides the instance window/, "the missing setting is named");
    assert.match(out, /it stays on screen for the whole run/, "and why it matters");
    assert.match(out, /action=init force=true/, "with the way to fix it");

    const kept = await e2eAction(fs, { action: "init", projectDir: dir });
    assert.match(kept, /OUT OF DATE/, "init must warn too, not silently keep a stale config");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a current config reports no drift", async () => {
  const dir = await project();
  try {
    await e2eAction(fs, { action: "init", projectDir: dir });
    const out = await e2eAction(fs, { action: "status", projectDir: dir });
    assert.match(out, /config:\s+up to date/);
    assert.doesNotMatch(out, /OUT OF DATE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
