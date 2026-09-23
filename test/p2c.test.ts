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
import { e2eAction, findVault, pluginDirFor, posixRel, renderTemplate } from "../lib/e2e.js";

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

test("renderTemplate substitutes the plugin identity and the vault", () => {
  const out = renderTemplate("id={{PLUGIN_ID}} name={{PLUGIN_NAME}} dir={{PLUGIN_DIR}} vault={{VAULT_DIR}}", {
    pluginId: "demo-notes",
    pluginName: "Demo Notes",
    pluginDir: ".",
    vaultDir: "./Test",
  });
  assert.equal(out, "id=demo-notes name=Demo Notes dir=. vault=./Test");
});

test("posixRel produces the project-relative form the config expects", () => {
  assert.equal(posixRel("/p", "/p/Test"), "./Test");
  assert.equal(posixRel("/p", "/p/e2e/vault"), "./e2e/vault");
  assert.equal(posixRel("/p", "/p"), ".");
});

test("a custom scaffold directory is collected by the runner", async () => {
  const dir = await project();
  try {
    await e2eAction(fs, { action: "init", projectDir: dir, dir: "checks" });
    assert.equal(await fs.exists(join(dir, "checks", "specs", "example.e2e.ts")), true, "the spec follows dir");
    const conf = await readFile(join(dir, "wdio.conf.mts"), "utf8");
    // A hardcoded "./e2e/specs/**" would write the spec where nothing collects it,
    // making `dir` a parameter that silently does nothing.
    assert.match(conf, /specs: \["\.\/checks\/specs\/\*\*\/\*\.e2e\.ts"\]/, "the glob must follow dir");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the config installs from wherever the built artifacts actually live", async () => {
  const dir = await project();
  try {
    // A real layout from the survey: the project builds into its own test vault.
    const artifact = join(dir, "TestVault", ".obsidian", "plugins", "demo-notes");
    await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, "main.js"), "module.exports = {};\n");
    await writeFile(join(artifact, "manifest.json"), JSON.stringify({ id: "demo-notes" }));
    await e2eAction(fs, { action: "init", projectDir: dir }, {}, artifact);
    const conf = await readFile(join(dir, "wdio.conf.mts"), "utf8");
    assert.match(conf, /plugins: \["TestVault\/\.obsidian\/plugins\/demo-notes"\]/, "the installer must be pointed at the artifacts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findVault reuses a test vault the project already has", async () => {
  const dir = await project();
  try {
    await mkdir(join(dir, "TestVault", ".obsidian"), { recursive: true });
    const found = await findVault(fs, dir, join(dir, "e2e"));
    assert.equal(found.existing, true);
    assert.equal(found.dir, join(dir, "TestVault"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findVault prefers a test-named vault over a folder of notes", async () => {
  const dir = await project();
  try {
    // Both are vaults; copying the wrong one silently changes what is tested.
    await mkdir(join(dir, "Notes", ".obsidian"), { recursive: true });
    await mkdir(join(dir, "Test", ".obsidian"), { recursive: true });
    for (let i = 0; i < 30; i++) await writeFile(join(dir, "Notes", `n${i}.md`), "# n\n");
    const found = await findVault(fs, dir, join(dir, "e2e"));
    assert.equal(found.dir, join(dir, "Test"), "the test-named vault wins even when smaller");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findVault ignores hidden, dependency and scaffold directories", async () => {
  const dir = await project();
  try {
    for (const name of ["node_modules", ".obsidian-cache", "e2e"]) {
      await mkdir(join(dir, name, "Inner", ".obsidian"), { recursive: true });
    }
    const found = await findVault(fs, dir, join(dir, "e2e"));
    assert.equal(found.existing, false, "a vault inside node_modules/the scaffold is not a candidate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init creates a vault when the project has none, so the first run works", async () => {
  const dir = await project();
  try {
    const out = await e2eAction(fs, { action: "init", projectDir: dir });
    // Without this the service aborts in onPrepare before any spec runs:
    // `Vault "…/e2e/vault" doesn't exist`.
    assert.match(out, /created empty/);
    assert.equal(await fs.isDirectory(join(dir, "e2e", "vault", ".obsidian")), true, "the vault must exist after init");
    assert.equal(await fs.exists(join(dir, "e2e", "vault", ".gitkeep")), true, "a marker must survive a clone");
    const conf = await readFile(join(dir, "wdio.conf.mts"), "utf8");
    assert.match(conf, /const E2E_VAULT = "\.\/e2e\/vault"/, "the config must point at the vault that now exists");
    assert.doesNotMatch(conf, /\{\{/, "no placeholder may survive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the reused vault is opened as a copy, so tests never write to it", async () => {
  const dir = await project();
  try {
    await mkdir(join(dir, "Test", ".obsidian"), { recursive: true });
    await writeFile(join(dir, "Test", "note.md"), "# real note\n");
    await e2eAction(fs, { action: "init", projectDir: dir });
    const conf = await readFile(join(dir, "wdio.conf.mts"), "utf8");
    // The service copies unless told otherwise (`copy: obsidianOptions.copy ?? true`),
    // so this is the guarantee that pointing E2E_VAULT at a real test vault cannot
    // modify it — the strongest form of "never touch the user's data" available here.
    assert.match(conf, /vault: E2E_VAULT,\s*\n\s*copy: true/, "the vault must be copied, never opened in place");
    assert.equal(await readFile(join(dir, "Test", "note.md"), "utf8"), "# real note\n", "scaffolding must not touch vault contents");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("init reuses an existing vault instead of inventing one", async () => {
  const dir = await project();
  try {
    await mkdir(join(dir, "Test", ".obsidian"), { recursive: true });
    const out = await e2eAction(fs, { action: "init", projectDir: dir });
    assert.match(out, /already in the project/);
    assert.equal(await fs.exists(join(dir, "e2e", "vault")), false, "no second vault is created");
    const conf = await readFile(join(dir, "wdio.conf.mts"), "utf8");
    assert.match(conf, /const E2E_VAULT = "\.\/Test"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status names a vault the config points at but that does not exist", async () => {
  const dir = await project();
  try {
    await writeFile(
      join(dir, "wdio.conf.mts"),
      'const E2E_VAULT = "./e2e/vault";\n' +
        'const config = { services: ["obsidian"], capabilities: [{ browserName: "obsidian", "goog:chromeOptions": { args: ["--no-sandbox"] }, "wdio:obsidianOptions": { vault: E2E_VAULT, copy: true, plugins: ["."] } }], before: async function () { for (const w of []) w.hide(); } };\nexport { config };\n',
    );
    const out = await e2eAction(fs, { action: "status", projectDir: dir });
    assert.match(out, /vault: {4}\.\/e2e\/vault MISSING/);
    assert.match(out, /fail in onPrepare/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
    // Rendered, not hardcoded: the installer needs main.js directly under this
    // path. This project passes its artifact directory explicitly (the test-vault
    // layout), so the config must name that directory, not a fixed ".".
    assert.match(conf, /plugins: \["TestVault\/\.obsidian\/plugins\/demo-notes"\]/, "the config installs from the real artifact directory");
    assert.doesNotMatch(conf, /\{\{/, "no placeholder may survive");
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
    // The vault directory itself must stay tracked: ignoring it wholesale makes a
    // fresh clone fail the first run in onPrepare, the same way the original bug did.
    assert.doesNotMatch(gitignore, /^e2e\/vault\/$/m, "a bare `e2e/vault/` would ignore the directory itself");
    assert.match(gitignore, /^e2e\/vault\/\*$/m, "ignore the vault's contents");
    assert.match(gitignore, /^!e2e\/vault\/\.gitkeep$/m, "but keep the marker that preserves the directory");
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
