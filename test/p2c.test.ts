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
    assert.match(conf, /"demo-notes"/, "the plugin id is baked into the config");
    assert.match(conf, /TestVault\/\.obsidian\/plugins\/demo-notes/, "the sandbox installs from where the project builds");
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
    assert.match(conf, /switch windows and steal\s+\/\/ your focus|switch windows and steal/i);
    assert.match(conf, /isolated user-configuration directory/);
    assert.match(conf, /copy: true/, "the sandbox must work on a copy of the vault");
    assert.match(conf, /earliest/, "minAppVersion is the default version under test");
    assert.match(conf, /UND_ERR_BODY_TIMEOUT|obsidian-cache/, "the first-run download is documented");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
