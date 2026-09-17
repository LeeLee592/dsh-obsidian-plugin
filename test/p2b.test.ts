// P2b tests: the offline smoke report, plus one end-to-end run against a
// synthetic plugin (the real three — float-mark, editing-toolbar,
// obsidian-tasks — are exercised by the acceptance runs, not the unit suite).

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fs } from "../lib/fs.js";
import { parseHarnessOutput, renderSmokeReport, testPlugin } from "../lib/harness.js";

const fs = new Fs();

const marker = (result: unknown) => `stuff\n__HARNESS_RESULT__ ${JSON.stringify(result)}\n`;

test("parseHarnessOutput reads the marker line, not the human output", () => {
  const parsed = parseHarnessOutput(marker({ ok: true, checks: [], summary: "fine" }));
  assert.equal(parsed?.ok, true);
  assert.equal(parsed?.summary, "fine");

  assert.equal(parseHarnessOutput("no marker here"), undefined);
  assert.equal(parseHarnessOutput("__HARNESS_RESULT__ {not json"), undefined);
});

test("a passing report states the environment limit explicitly", () => {
  const text = renderSmokeReport(
    { ok: true, checks: [{ name: "bundle loads", level: "pass" }], summary: "clean" },
    "",
  );
  assert.match(text, /Smoke test: PASS/);
  assert.match(text, /offline stub environment, NOT the real app/);
  assert.match(text, /obsidian_plugin_inspect|obsidian_plugin_e2e/);
  assert.doesNotMatch(text, /verified working|works correctly/i);
});

test("a failing report shows every failed check and keeps the limit note", () => {
  const text = renderSmokeReport(
    {
      ok: false,
      summary: "onload() threw",
      checks: [
        { name: "bundle loads", level: "pass" },
        { name: "onload() completed without throwing", level: "fail", detail: "boom\n  at file:1:1" },
        { name: "DOM host available", level: "warn", detail: "no jsdom" },
      ],
    },
    "",
  );
  assert.match(text, /Smoke test: FAIL — onload\(\) threw/);
  assert.match(text, /✗ onload\(\) completed without throwing: boom/);
  assert.match(text, /! DOM host available: no jsdom/);
  assert.match(text, /offline stub environment/);
});

/** Write a synthetic plugin project whose bundle does whatever `body` says. */
async function project(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "p2b-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({ id: "smoke-demo", name: "Smoke Demo", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" }),
  );
  await writeFile(join(dir, "main.js"), body);
  return dir;
}

test("end to end: a well-behaved bundle passes, and the report carries the limit note", async () => {
  const dir = await project(`
    const { Plugin } = require("obsidian");
    class Demo extends Plugin {
      async onload() { this.addCommand({ id: "demo-cmd", name: "Demo", callback() {} }); }
      async onunload() {}
    }
    module.exports = Demo;
  `);
  try {
    const out = await testPlugin(fs, { projectDir: dir });
    assert.match(out, /Smoke test: PASS/);
    assert.match(out, /offline stub environment/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end to end: an onload() that throws fails with the real message", async () => {
  const dir = await project(`
    const { Plugin } = require("obsidian");
    class Demo extends Plugin {
      async onload() { throw new Error("kaboom from onload"); }
    }
    module.exports = Demo;
  `);
  try {
    const out = await testPlugin(fs, { projectDir: dir });
    assert.match(out, /Smoke test: FAIL/);
    assert.match(out, /kaboom from onload/, "the plugin's own message must survive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end to end: a wrong export shape is reported as such", async () => {
  const dir = await project("module.exports = { not: 'a plugin' };\n");
  try {
    const out = await testPlugin(fs, { projectDir: dir });
    assert.match(out, /Smoke test: FAIL/);
    assert.match(out, /default export is a Plugin subclass/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("end to end: a bundle with no main.js points at build instead of guessing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p2b-"));
  try {
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ id: "smoke-demo", name: "D", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" }));
    const out = await testPlugin(fs, { projectDir: dir });
    assert.match(out, /run obsidian_plugin_build first/);
    assert.match(out, /Looked for main\.js in:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
