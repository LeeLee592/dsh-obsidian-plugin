// P3 tests: the eval tool's guardrails (pure parts — the live call is exercised
// by hand against a running app, not in unit tests).

import assert from "node:assert/strict";
import { test } from "node:test";
import { focusWarning } from "../lib/eval.js";

test("focus-moving code is flagged, benign code is not", () => {
  assert.match(focusWarning('require("electron").remote.getCurrentWindow().focus()') ?? "", /window focus/);
  assert.match(focusWarning("win.moveTop()") ?? "", /moveTop/);
  assert.match(focusWarning("new BrowserWindow({})") ?? "", /BrowserWindow/);

  assert.equal(focusWarning("app.vault.getName()"), undefined);
  assert.equal(focusWarning("Object.keys(app.plugins.plugins)"), undefined);
  assert.equal(focusWarning("document.querySelector('.x').classList.add('y')"), undefined);
});

test("the focus warning names the sandboxed alternative", () => {
  const warning = focusWarning("w.focus()") ?? "";
  assert.match(warning, /focus may have jumped/);
  assert.match(warning, /sandboxed e2e tier needs no window/);
});
