// P2a tests: entry-point and artifact resolution against real project shapes.
//
// The shapes come from the community survey (DESIGN.md §2.8): entries live at
// src/main.ts, a repository-root main.ts, or src/plugin/main.ts; output lands in
// the project root, in `dir: '.'`, or inside the project's own test vault.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fs } from "../lib/fs.js";
import {
  extractEntryCandidates,
  extractOutputHints,
  resolveArtifact,
  resolveEntry,
} from "../lib/lookup.js";

const fs = new Fs();

/** Build a throwaway project: `files` are relative paths, empty string = empty file. */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "p2a-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

test("entry: prefers src/main.ts when present", async () => {
  const dir = await project({ "src/main.ts": "", "main.ts": "" });
  try {
    const r = await resolveEntry(fs, dir);
    assert.ok(r.ok);
    assert.equal(r.ok && r.resolution.displayPath, "src/main.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entry: falls back to a repository-root main.ts (obsidian-tasks, recent-files)", async () => {
  const dir = await project({ "main.ts": "" });
  try {
    const r = await resolveEntry(fs, dir);
    assert.ok(r.ok);
    assert.equal(r.ok && r.resolution.displayPath, "main.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entry: reads entryPoints from an esbuild config", async () => {
  const dir = await project({
    "esbuild.config.mjs": "const c = { entryPoints: [\"src/plugin/main.ts\"], outfile: \"main.js\" };",
    "src/plugin/main.ts": "",
  });
  try {
    const r = await resolveEntry(fs, dir);
    assert.ok(r.ok);
    assert.equal(r.ok && r.resolution.displayPath, "src/plugin/main.ts");
    assert.equal(r.ok && r.resolution.source, "esbuild config");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entry: reads input from a rollup config (editing-toolbar shape)", async () => {
  const dir = await project({
    "rollup.config.js": "export default { input: \"src/plugin/main.ts\", output: { dir: \"./Test-Vault/.obsidian/plugins/x\" } };",
    "src/plugin/main.ts": "",
  });
  try {
    const r = await resolveEntry(fs, dir);
    assert.ok(r.ok);
    assert.equal(r.ok && r.resolution.displayPath, "src/plugin/main.ts");
    assert.equal(r.ok && r.resolution.source, "rollup config");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entry: explicit argument wins and a missing one is reported", async () => {
  const dir = await project({ "src/main.ts": "" });
  try {
    const explicit = await resolveEntry(fs, dir, { entry: "src/other.ts" });
    assert.equal(explicit.ok, false);
    assert.match(explicit.ok === false ? explicit.failure.header : "", /does not exist/);

    await writeFile(join(dir, "src", "other.ts"), "");
    const ok = await resolveEntry(fs, dir, { entry: "src/other.ts" });
    assert.ok(ok.ok);
    assert.equal(ok.ok && ok.resolution.source, "argument");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("entry: failure lists every candidate tried", async () => {
  const dir = await project({ "package.json": "{}" });
  try {
    const r = await resolveEntry(fs, dir);
    assert.equal(r.ok, false);
    const tried = r.ok === false ? r.failure.tried : [];
    assert.ok(tried.includes("src/main.ts"));
    assert.ok(tried.includes("main.ts"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact: project root is preferred", async () => {
  const dir = await project({ "main.js": "module.exports = {};" });
  try {
    const r = await resolveArtifact(fs, dir);
    assert.ok(r.ok);
    assert.equal(r.ok && r.resolution.source, "project root");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact: follows outdir from the config (obsidian-tasks uses outdir: '.')", async () => {
  const dir = await project({
    "esbuild.config.mjs": "const c = { entryPoints: ['main.ts'], outdir: '.' };",
    "main.js": "",
  });
  try {
    const r = await resolveArtifact(fs, dir);
    assert.ok(r.ok, "outdir: '.' resolves to the project root");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact: follows a rollup output.dir inside a project vault (editing-toolbar, dataview)", async () => {
  const dir = await project({
    "rollup.config.js": 'export default { output: { dir: "./Editing-Toolbar-Test-Vault/.obsidian/plugins/editing-toolbar" } };',
    "Editing-Toolbar-Test-Vault/.obsidian/plugins/editing-toolbar/main.js": "",
  });
  try {
    const r = await resolveArtifact(fs, dir);
    assert.ok(r.ok);
    assert.equal(r.ok && r.resolution.source, "bundler config");
    assert.match(r.ok ? r.resolution.detail : "", /rollup\.config\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact: finds a project-local vault layout (.obsidian/plugins/<id>)", async () => {
  const dir = await project({ ".obsidian/plugins/my-notes/main.js": "" });
  try {
    // The directory is hidden, so a plain search must not find it...
    const withoutId = await resolveArtifact(fs, dir, { pluginId: "my-notes" });
    assert.ok(withoutId.ok, "the vault layout inside the project is discovered");
    assert.match(withoutId.ok ? withoutId.resolution.path : "", /my-notes\/main\.js$/);

    // ...and passing outDir remains the explicit escape hatch.
    const explicit = await resolveArtifact(fs, join(dir, ".obsidian", "plugins", "my-notes"), { pluginId: "my-notes" });
    assert.ok(explicit.ok);
    assert.equal(explicit.ok && explicit.resolution.source, "project root");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact: bounded search finds an arbitrary vault directory but skips noise", async () => {
  const dir = await project({
    "Editing-Toolbar-Test-Vault/.obsidian/plugins/x/main.js": "",
    "node_modules/pkg/main.js": "",
    "src/main.ts": "",
  });
  try {
    const r = await resolveArtifact(fs, dir, { pluginId: "x" });
    // The .obsidian convention path is checked first and matches here.
    assert.ok(r.ok);
    assert.ok(!r.ok ? false : r.resolution.path.includes("Editing-Toolbar-Test-Vault"));
    assert.ok(!r.ok ? false : !r.resolution.path.includes("node_modules"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("artifact: failure reports every location tried", async () => {
  const dir = await project({ "package.json": "{}", "src/main.ts": "" });
  try {
    const r = await resolveArtifact(fs, dir, { pluginId: "demo" });
    assert.equal(r.ok, false);
    assert.ok(r.ok === false && r.tried.length > 0);
    assert.ok(r.ok === false && r.tried.some((t) => t.includes("project root")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("config scanning extracts only file-like literals and output keys", () => {
  assert.deepEqual(
    extractEntryCandidates("entryPoints: ['main.ts', 'styles.scss'],", ["entryPoints"]),
    ["main.ts"],
    "only script files are entry candidates",
  );
  assert.deepEqual(extractEntryCandidates("input: \"src/main.ts\",", ["input"]), ["src/main.ts"]);
  assert.deepEqual(extractEntryCandidates("entryPoints: someVariable,", ["entryPoints"]), []);

  const hints = extractOutputHints("outfile: \"main.js\", outdir: '.', dir: \"./vault/x\"");
  assert.deepEqual(hints, ["main.js", ".", "./vault/x"]);
});

test("build uses the project script when a bundler config exists", async () => {
  // obsidian-tasks and float-mark both need plugins from their own config; our
  // direct esbuild flags cannot supply esbuild-svelte. So a project with a
  // config AND a build script must go through the script.
  const dir = await project({
    "manifest.json": JSON.stringify({ id: "demo-notes", name: "Demo", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" }),
    "src/main.ts": "export default class P {}",
    "esbuild.config.mjs": "export default { entryPoints: ['src/main.ts'] };",
    "package.json": JSON.stringify({ scripts: { build: "node -e \"require('fs').writeFileSync('main.js','module.exports=require(\\\"obsidian\\\");')\"" } }),
  });
  try {
    const { buildPlugin } = await import("../lib/build.js");
    const out = await buildPlugin(fs, { projectDir: dir });
    assert.match(out, /via project build script \(production\)/, "the project script must win when a config exists");
    assert.match(out, /entry:\s+src\/main\.ts/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
