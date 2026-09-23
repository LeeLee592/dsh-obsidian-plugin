// P1 tests: CLI result classification, eval parsing, argv assembly, truncation.
//
// These are the decisions that must hold no matter how flaky the CLI is, so they
// are pure functions and can be tested without a live Obsidian.

import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, explainCliFailure } from "../lib/cli.js";
import { cliArgs, parseEvalJson, truncate } from "../lib/inspect.js";
import { registryPath } from "../lib/vault.js";
import { reloadPlugin, writeScopeRefusal } from "../lib/reload.js";

const ok = (output: string) => ({ ok: true, reason: undefined, output, errorMessage: undefined });

test("a zero exit with no output is a hang, not a success", () => {
  // The exact combination we reproduced live: silence plus status 0.
  assert.equal(classify(ok("")).status, "hang");
  assert.equal(classify(ok("   \n ")).status, "hang");
});

test("a timeout is reported as a hang with retry guidance", () => {
  const verdict = classify({ ok: false, reason: "timeout", output: "", errorMessage: undefined });
  assert.equal(verdict.status, "hang");
  assert.match(verdict.detail ?? "", /restart Obsidian/);
});

test("a missing executable is distinguished from a failing command", () => {
  const verdict = classify({ ok: false, reason: "spawn-error", output: "", errorMessage: "spawnSync obsidian ENOENT" });
  assert.equal(verdict.status, "missing");
  assert.match(verdict.detail ?? "", /ENOENT/);
});

test("a wrong-window answer is classified as unavailable, not as an error", () => {
  // Reproduced live when the active vault was Notes.
  const cmd = classify(ok('Error: Command "plugins:enabled" not found. It may require a plugin to be enabled.'));
  assert.equal(cmd.status, "unavailable");
  const plugin = classify(ok('Error: Plugin "feishu-style-editor" not found. Use "plugins" to list available plugins.'));
  assert.equal(plugin.status, "unavailable");
  const vault = classify(ok("Vault not found."));
  assert.equal(vault.status, "unavailable");
});

test("a real error is an error even when the exit status is zero", () => {
  assert.equal(classify(ok("Error: something went wrong")).status, "error");
  assert.equal(classify({ ok: false, reason: "nonzero-exit", output: "boom", errorMessage: undefined }).status, "error");
});

test("successful output is ok", () => {
  assert.equal(classify(ok("Reloaded: demo")).status, "ok");
});

test("each failure status gets a distinct, actionable explanation", () => {
  const missing = explainCliFailure({ status: "missing", output: "", attempts: 1, timeoutMs: 1 }, "ctx");
  const hang = explainCliFailure({ status: "hang", output: "", attempts: 2, timeoutMs: 1 }, "ctx");
  const unavailable = explainCliFailure({ status: "unavailable", output: "", attempts: 1, timeoutMs: 1 }, "ctx");
  assert.match(missing, /Settings → General → Command line interface/);
  assert.match(hang, /did not respond/);
  assert.match(unavailable, /Bring the target vault to the front/);
});

test("eval output is parsed out of the CLI's `=>` prefix", () => {
  const parsed = parseEvalJson('=> {\n  "vault": "TestVault",\n  "appId": "abc"\n}');
  assert.equal(parsed.vault, "TestVault");
  assert.equal(parseEvalJson("=> true"), true);
  assert.equal(parseEvalJson("not an eval result"), undefined);
});

test("vault= is placed first and flags are appended only when asked", () => {
  assert.deepEqual(cliArgs("TestVault", ["plugins:enabled", "filter=community"]), [
    "vault=TestVault",
    "plugins:enabled",
    "filter=community",
  ]);
  assert.deepEqual(cliArgs(undefined, ["dev:errors"]), ["dev:errors"]);
  assert.deepEqual(cliArgs("V", ["dev:console"], { level: "error", limit: 10, clear: true }), [
    "vault=V",
    "dev:console",
    "level=error",
    "limit=10",
    "clear",
  ]);
});

test("observation output is capped so noise cannot flood the context", () => {
  const long = "x".repeat(40 * 1024);
  const capped = truncate(long);
  assert.ok(capped.length < long.length);
  assert.match(capped, /truncated/);
  assert.equal(truncate("short"), "short");
});

test("the vault registry path follows the platform", () => {
  assert.match(registryPath("darwin", "/Users/x") ?? "", /Library\/Application Support\/obsidian\/obsidian\.json$/);
  assert.match(registryPath("linux", "/home/x") ?? "", /\.config\/obsidian\/obsidian\.json$/);
  assert.equal(registryPath("freebsd", "/x"), undefined);
});

test("reload refuses to run without a plugin id", async () => {
  const out = await reloadPlugin({ action: "reload" });
  assert.match(out, /provide pluginId/);
});

test("reload resolves the id from the project manifest", async () => {
  // No live CLI: the plugin id lookup must still work, and the call must fail
  // fast with a CLI report rather than throwing.
  let asked: string | undefined;
  const out = await reloadPlugin(
    { action: "reload", projectDir: "/tmp/whatever", vault: "V" },
    {
      cli: { timeoutMs: 1, retries: 0 },
      readManifestId: async (dir: string) => {
        asked = dir;
        return "demo-notes";
      },
    },
  );
  assert.equal(asked, "/tmp/whatever");
  assert.ok(out.length > 0);
});

test("an app-side write outside the workspace is refused before any command runs", async () => {
  const root = "/ws/session";
  // These go through the OBSIDIAN app, so the file sandbox cannot see them: a
  // doc-level promise that they are gated is only true if this check exists.
  assert.match(writeScopeRefusal("/Users/leelee/Documents/MyVault", root) ?? "", /refusing to run an app-side write/);
  // A sibling directory sharing the workspace prefix is not inside it.
  assert.match(writeScopeRefusal("/ws/session-evil/vault", root) ?? "", /refusing/);
  assert.equal(writeScopeRefusal("/ws/session/TestVault", root), undefined, "the test vault is allowed");
  assert.equal(writeScopeRefusal("/ws/session", root), undefined, "the workspace root itself is allowed");
  assert.equal(writeScopeRefusal(undefined, root), undefined, "no path given: the active window is the target, not locatable here");

  // The refusal must happen before the CLI is consulted at all.
  const target = "/Users/leelee/Documents/MyVault";
  const out = await reloadPlugin({ vault: target, action: "enable", pluginId: "x" }, { workspaceRoot: root });
  assert.match(out, /refusing to run an app-side write/);
  assert.doesNotMatch(out, /Enabled x/, "no command may have run");
});
