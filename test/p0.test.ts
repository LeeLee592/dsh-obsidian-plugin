// P0 tests: offline build + deploy.
//
// Runs in bare Node (no Cordis host): the Fs seam falls back to node:fs when no
// ctx.fs is injected, which is exactly the path these tests exercise.
//
//   node --test src/__tests__/p0.test.ts        (Node 22+ strips types)
//   pnpm run test

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fs } from "../lib/fs.js";
import { buildPlugin, buildArgs } from "../lib/build.js";
import { deployPlugin, resolveVault, BINDING_FILE } from "../lib/deploy.js";
import { namingProblems, isSemver } from "../lib/naming.js";

const fs = new Fs(); // no ctx.fs → node:fs fallback

async function makeProject(dir: string, manifest: Record<string, unknown>, extra: Record<string, string> = {}) {
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(dir, "src", "main.ts"), "export default class P {}\n");
  for (const [name, content] of Object.entries(extra)) {
    await writeFile(join(dir, name), content);
  }
}

test("buildArgs externalizes the obsidian runtime and targets CommonJS", () => {
  const args = buildArgs(true);
  assert.ok(args.includes("--format=cjs"), "must emit CommonJS for Obsidian");
  assert.ok(args.includes("--external:obsidian"), "obsidian must stay external");
  assert.ok(args.includes("--external:@codemirror/view"), "CodeMirror must stay external");
  assert.ok(args.includes("--outfile=main.js"), "output must be main.js at the project root");
});

test("build fails with an actionable message when the entry point is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  try {
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ id: "x", name: "X", version: "1.0.0" }));
    const out = await buildPlugin(fs, { projectDir: dir });
    assert.match(out, /entry point not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("build fails clearly when no bundler is available", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  try {
    await makeProject(dir, { id: "x", name: "X", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" });
    const out = await buildPlugin(fs, { projectDir: dir });
    assert.match(out, /no local esbuild and no usable build script/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("build reports a non-CommonJS bundle instead of shipping it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  try {
    await makeProject(dir, { id: "x", name: "X", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" }, {
      "main.js": "export default class P {}\n",
    });
    const bin = join(dir, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    // A fake esbuild that leaves the ESM main.js untouched.
    await writeFile(join(bin, "esbuild"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const out = await buildPlugin(fs, { projectDir: dir });
    assert.match(out, /looks like an ES module/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("build warns when obsidian was bundled instead of externalized", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  try {
    await makeProject(dir, { id: "x", name: "X", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" });
    const bin = join(dir, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    const bundle = "module.exports = {};\n";
    await writeFile(
      join(bin, "esbuild"),
      `#!/bin/sh\ncat > main.js <<'EOF'\n${bundle}EOF\nexit 0\n`,
      { mode: 0o755 },
    );

    const out = await buildPlugin(fs, { projectDir: dir });
    assert.match(out, /no runtime reference to "obsidian"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deploy refuses to invent a vault", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  try {
    await makeProject(dir, { id: "x", name: "X", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" }, {
      "main.js": "module.exports = require('obsidian');\n",
    });
    const out = await deployPlugin(fs, { projectDir: dir });
    assert.match(out, /no target vault resolved/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deploy requires build artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  try {
    await makeProject(dir, { id: "x", name: "X", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" });
    const out = await deployPlugin(fs, { projectDir: dir });
    assert.match(out, /missing build artifact/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deploy installs artifacts, merges the enable list, and remembers the vault", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  const vault = await mkdtemp(join(tmpdir(), "vault-"));
  try {
    await makeProject(dir, { id: "demo-notes", name: "Demo", version: "0.1.0", minAppVersion: "1.0.0", description: "d.", author: "a" }, {
      "main.js": "module.exports = require('obsidian');\n",
      "styles.css": ".x{}\n",
    });
    await mkdir(join(vault, ".obsidian", "plugins"), { recursive: true });
    // A pre-existing plugin entry must survive the merge.
    await writeFile(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["other-plugin"], null, "\t"));

    const out = await deployPlugin(fs, { projectDir: dir, vault });
    assert.match(out, /Deployed demo-notes 0.1.0/);
    assert.match(out, /enabled: yes/);
    assert.match(out, /active:  unknown/, "P0 must not claim the plugin is loaded");

    const installed = await readFile(join(vault, ".obsidian", "plugins", "demo-notes", "main.js"), "utf8");
    assert.match(installed, /require\('obsidian'\)/);

    const list = JSON.parse(await readFile(join(vault, ".obsidian", "community-plugins.json"), "utf8"));
    assert.deepEqual(list, ["other-plugin", "demo-notes"], "existing entries must be preserved");

    const binding = JSON.parse(await readFile(join(dir, BINDING_FILE), "utf8"));
    assert.equal(binding.vault, vault);
    assert.equal(binding.pluginId, "demo-notes");
    assert.equal(binding.lastDeploy.active, "unknown");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("deploy reuses the binding and does not duplicate the enable entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  const vault = await mkdtemp(join(tmpdir(), "vault-"));
  try {
    await makeProject(dir, { id: "demo-notes", name: "Demo", version: "0.1.0", minAppVersion: "1.0.0", description: "d.", author: "a" }, {
      "main.js": "module.exports = require('obsidian');\n",
    });
    await mkdir(join(vault, ".obsidian", "plugins"), { recursive: true });

    await deployPlugin(fs, { projectDir: dir, vault });
    const out = await deployPlugin(fs, { projectDir: dir });
    assert.match(out, /resolved via binding/);

    const list = JSON.parse(await readFile(join(vault, ".obsidian", "community-plugins.json"), "utf8"));
    assert.deepEqual(list, ["demo-notes"], "the id must appear exactly once");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("resolveVault rejects a directory that is not a vault", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  const plain = await mkdtemp(join(tmpdir(), "plain-"));
  try {
    const resolved = await resolveVault(fs, dir, { projectDir: dir, vault: plain });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.match(resolved.message, /does not look like a vault/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  }
});

test("submission naming rules stay identical to the validate/scaffold guardrails", () => {
  assert.deepEqual(namingProblems("demo-notes", "Demo", "Does a thing."), []);
  assert.ok(namingProblems("obsidian-demo", "Demo", "Does a thing.").some((e) => /cannot contain "obsidian"/.test(e)));
  assert.ok(namingProblems("demo-notes", "Demo Plugin", "Does a thing.").some((e) => /cannot end with "Plugin"/.test(e)));
  assert.ok(namingProblems("demo", "Demo", "Does a thing").some((e) => /end with punctuation/.test(e)));
  assert.equal(isSemver("1.0.0"), true);
  assert.equal(isSemver("v1.0"), false);
});

test("build reports the degradation tier and states that checks are static scans", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  try {
    await makeProject(dir, { id: "tier-demo", name: "Tier", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" });
    const bin = join(dir, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "esbuild"),
      "#!/bin/sh\nprintf \"module.exports = require('obsidian');\\n\" > main.js\nexit 0\n",
      { mode: 0o755 },
    );

    const out = await buildPlugin(fs, { projectDir: dir });
    assert.match(out, /via project-local esbuild/, "the tier actually used must be reported");
    assert.match(out, /static scans of the bundle, not a load test/, "must not imply the bundle was loaded");
    assert.doesNotMatch(out, /testing|verified working/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("build surfaces a failing bundler instead of reporting success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  try {
    await makeProject(dir, { id: "fail-demo", name: "Fail", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" });
    const bin = join(dir, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "esbuild"), "#!/bin/sh\necho 'boom: cannot resolve' >&2\nexit 1\n", { mode: 0o755 });

    const out = await buildPlugin(fs, { projectDir: dir });
    assert.match(out, /Build failed/);
    assert.match(out, /boom: cannot resolve/, "the bundler's own diagnostics must reach the caller");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deploy never claims the plugin is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "p0-"));
  const vault = await mkdtemp(join(tmpdir(), "vault-"));
  try {
    await makeProject(dir, { id: "state-demo", name: "State", version: "1.0.0", minAppVersion: "1.0.0", description: "d.", author: "a" }, {
      "main.js": "module.exports = require('obsidian');\n",
    });
    await mkdir(join(vault, ".obsidian"), { recursive: true });

    const out = await deployPlugin(fs, { projectDir: dir, vault });
    assert.match(out, /written/, "the written state is reported");
    assert.match(out, /enabled: yes/, "the enabled state is reported");
    assert.match(out, /active:  unknown/, "loading is NOT claimed");
    assert.match(out, /has no live-app integration/, "the limitation is stated explicitly");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(vault, { recursive: true, force: true });
  }
});

test("the plugin registers every tool through the real defineTool validator", async () => {
  // Regression guard: tool `parameters` must be a property map
  // ({ name: { type, required?, description } }), not a JSON Schema root.
  // A JSON Schema root throws inside defineTool, which would make apply()
  // fail at load time and take the entire plugin down.
  const mod: any = await import("../lib/index.js");
  const registered: any[] = [];
  const ctx = { tools: { register: (t: unknown) => registered.push(t) }, get: () => undefined };

  mod.apply(ctx, {});

  const names = registered.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "obsidian_plugin_build",
    "obsidian_plugin_deploy",
    "obsidian_plugin_e2e",
    "obsidian_plugin_inspect",
    "obsidian_plugin_reload",
    "obsidian_plugin_scaffold",
    "obsidian_plugin_test",
    "obsidian_plugin_validate",
    "obsidian_plugin_vault",
    "obsidian_plugin_version",
  ]);
  assert.equal(mod.name, "obsidian-plugin");
  assert.deepEqual(mod.inject, ["tools", "fs"]);
});

test("a JSON Schema parameter root is rejected by the tool API", async () => {
  const { defineTool } = await import("@deepseek-ai/dsh-tools");
  const output = { schema: { type: "string" }, render: (_a: unknown, v: string) => [{ type: "text", text: v }] };
  const base = { name: "probe", description: "x".repeat(40), output, async execute() { return "ok"; } };

  // The supported shape.
  defineTool({
    ...base,
    parameters: { a: { type: "string", required: true, description: "d" } },
  });

  // The unsupported shape must fail loudly rather than registering silently.
  assert.throws(
    () => defineTool({ ...base, parameters: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } }),
    /unsupported JSON schema/i,
  );
});
