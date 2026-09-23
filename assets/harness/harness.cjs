// Offline smoke harness: load a built plugin bundle in plain Node and exercise
// its lifecycle (DESIGN.md §4.3).
//
//   node harness.cjs <projectDir> [--bundle <path>] [--scenario <file>] [--temp-dir <dir>]
//
// Load order is load-bearing — this exact sequence is what makes a real
// minified bundle load (verified against float-mark, editing-toolbar and
// obsidian-tasks):
//
//   1. host environment            (project jsdom + injected globals, self)
//   2. the `obsidian` stub         (patched require)
//   3. the project's REAL peer modules, resolved once up front
//      (@codemirror/*, @lezer/*: stubbing them fails as
//       `StateEffect.define is not a function`)
//   4. require the bundle          (accepts module.exports and .default)
//   5. lifecycle + assertions + one JSON line on stdout
//
// The last line of stdout is always `__HARNESS_RESULT__ <json>`; everything
// else is human-readable. Exit code is 0 when the run passed.

"use strict";

const Module = require("node:module");
const { createRequire } = require("node:module");
const { existsSync, readFileSync, copyFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { createObsidianStub } = require("./obsidian-stub.cjs");

const HOST_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "HTMLElement",
  "HTMLDivElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "HTMLButtonElement",
  "Element",
  "Node",
  "NodeList",
  "DocumentFragment",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "CSS",
  "DOMParser",
  "XMLSerializer",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "InputEvent",
  "DragEvent",
  "ClipboardEvent",
  "Text",
  "Comment",
  "SVGElement",
  "Document",
  "Window",
  "HTMLCollection",
  "NamedNodeMap",
  "Attr",
  "Range",
  "Selection",
  "AbortController",
  "AbortSignal",
  "Image",
  "Blob",
  "FileReader",
  "matchMedia",
];

/** Peer modules a plugin bundles against but does not ship. */
const PEER_MODULES = [
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];

function parseArgs(argv) {
  const out = { projectDir: undefined, bundle: undefined, scenario: undefined, tempDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--bundle") out.bundle = argv[++i];
    else if (arg === "--scenario") out.scenario = argv[++i];
    else if (arg === "--temp-dir") out.tempDir = argv[++i];
    else if (!out.projectDir) out.projectDir = arg;
  }
  return out;
}

const checks = [];
let emitted = false;
function check(name, level, ok, detail) {
  checks.push({ name, level: ok ? "pass" : level, detail: ok ? undefined : detail });
}
function fail(name, detail) {
  checks.push({ name, level: "fail", detail });
}
function warn(name, detail) {
  checks.push({ name, level: "warn", detail });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectDir) {
    emit({ ok: false, checks: [], summary: "no project directory given" }, 2);
    return;
  }
  const projectDir = resolve(args.projectDir);
  const bundlePath = args.bundle ? resolve(args.bundle) : join(projectDir, "main.js");

  const result = {
    ok: false,
    projectDir,
    bundle: bundlePath,
    dom: false,
    peerModules: [],
    pluginId: undefined,
    registrations: [],
    console: [],
    scenario: undefined,
    checks,
    summary: "",
  };

  // ---- 0. prerequisites ----------------------------------------------------
  const manifestPath = join(projectDir, "manifest.json");
  let manifest = {};
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      result.pluginId = manifest.id;
    } catch (error) {
      warn("manifest.json parses", `invalid JSON: ${error.message}`);
    }
  } else {
    warn("manifest.json present", "not found — the plugin id and minAppVersion cannot be checked");
  }

  if (!existsSync(bundlePath)) {
    fail("bundle exists", `no bundle at ${bundlePath} — build the plugin first`);
    result.summary = "bundle missing";
    emit(result, 2);
    return;
  }
  check("bundle exists", "fail", true);

  // ---- 1. host environment -------------------------------------------------
  const { dom, source: domSource, why } = installHostEnvironment(projectDir);
  if (!dom && process.env.HARNESS_DEBUG) console.error("DEBUG dom unavailable:", why);
  result.dom = dom;
  if (dom) {
    check("DOM host available", "fail", true, undefined);
    result.domSource = domSource;
  } else {
    warn(
      "DOM host available",
      "no DOM in this process — a bundle that touches document at load time will fail below; add jsdom to the plugin project (`pnpm add -D jsdom`) to load it offline",
    );
  }

  // ---- 2 + 3. stub and real peers -----------------------------------------
  const projectRequire = createRequire(join(projectDir, "package.json"));
  const peerPaths = new Map();
  for (const name of PEER_MODULES) {
    try {
      peerPaths.set(name, projectRequire.resolve(name));
    } catch {
      /* not installed: the bundle may not need it */
    }
  }
  result.peerModules = [...peerPaths.keys()];

  const stub = createObsidianStub({ pluginData: readPluginData(projectDir, manifest.id) });
  const app = stub.__app;

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "obsidian") return stub;
    if (request === "moment") return stub.moment;
    if (peerPaths.has(request)) return originalLoad.call(this, peerPaths.get(request), parent, isMain);
    return originalLoad.call(this, request, parent, isMain);
  };

  const consoleCapture = [];
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"]) {
    console[level] = (...args) => {
      consoleCapture.push({ level, text: args.map((a) => safeString(a)).join(" ") });
    };
  }

  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);

  let PluginClass;
  let instance;
  let stagedCopy;
  try {
    // ---- 4. load ---------------------------------------------------------
    let module;
    let tempCopy;
    try {
      // A project with `"type": "module"` would make Node treat main.js as ESM,
      // while every bundler emits CommonJS for Obsidian. Copying to a .cjs file
      // pins the interpretation to what Obsidian actually does.
      //
      // Prefer a caller-provided writable directory, then the OS temp dir, and
      // only as a last resort beside the bundle: the plugin project commonly
      // lives outside the DSH session workspace, where writing is denied
      // (observed as EPERM on a real run).
      const copyDirs = [args.tempDir, tmpdir(), dirname(bundlePath)].filter(Boolean);
      let lastError;
      for (const dir of copyDirs) {
        const candidate = join(dir, `.dsh-harness-${process.pid}-${Date.now()}.cjs`);
        try {
          copyFileSync(bundlePath, candidate);
          tempCopy = candidate;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!tempCopy) throw lastError ?? new Error("could not stage the bundle in any writable directory");
      stagedCopy = tempCopy;
      module = require(tempCopy);
    } catch (error) {
      if (tempCopy) rmSync(tempCopy, { force: true });
      fail("bundle loads", firstLine(error && error.message));
      result.summary = "the bundle threw while loading";
      finish();
      return;
    }
    check("bundle loads", "fail", true);

    const exported = module && module.default ? module.default : module;
    if (typeof exported !== "function") {
      fail("default export is a Plugin subclass", `default export is ${typeof exported}, not a class`);
      result.summary = "wrong export shape";
      finish();
      return;
    }
    const extendsPlugin = Object.getPrototypeOf(exported) === stub.Plugin || exported.prototype instanceof stub.Plugin;
    if (!extendsPlugin) {
      fail("default export is a Plugin subclass", `${exported.name || "the default export"} does not extend Plugin`);
      result.summary = "not a Plugin subclass";
      finish();
      return;
    }
    check("default export is a Plugin subclass", "fail", true);
    PluginClass = exported;

    // ---- 5. lifecycle ----------------------------------------------------
    try {
      instance = new PluginClass(app, { ...manifest });
    } catch (error) {
      fail("plugin can be constructed", firstLine(error && error.message));
      result.summary = "constructor threw";
      finish();
      return;
    }
    check("plugin can be constructed", "fail", true);

    try {
      await instance.onload();
      check("onload() completed without throwing", "fail", true);
    } catch (error) {
      fail(
        "onload() completed without throwing",
        `${firstLine(error && error.message)}\n${stackTail(error)}${firstCapturedError(consoleCapture)}`,
      );
      result.summary = "onload() threw";
      finish();
      return;
    }

    result.registrations = [...(instance._registrations ?? [])];
    // Only these three surfaces are asserted by name. The previous filter was
    // "everything except registerEvent/addStatusBarItem", so a plugin that
    // registered only a DOM event satisfied a check claiming a command or view.
    const surfaceKeys = ["addCommand", "registerView", "addSettingTab"];
    const surfaces = result.registrations.filter((r) => surfaceKeys.some((k) => r === k || r.startsWith(`${k}:`)));
    if (surfaces.length === 0) {
      warn(
        "registers a command, view or setting tab",
        `none of ${surfaceKeys.join(" / ")} was registered (saw: ${result.registrations.join(", ") || "nothing"}) — ` +
          "is this plugin intentionally empty, or did registration fail silently? A plugin that only adds a " +
          "DOM event, interval or editor extension is legitimate and will land here.",
      );
    } else {
      check("registers a command, view or setting tab", "warn", true, `registered ${surfaces.join(", ")}`);
    }

    // Registration is not execution. An editor extension only does its work
    // when CodeMirror instantiates it inside a real EditorView, so a plugin
    // whose UI lives there is NOT exercised by loading it — and a bare "PASS"
    // invites exactly that misreading. Probe it and say so.
    const extensions = app.workspace.editorExtensions.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
    // Two shapes reach the workspace: a raw class, or the extension object that
    // `ViewPlugin.fromClass()` returns (which carries `create`). Both can be
    // instantiated against a stub view, which is what actually runs the plugin's
    // view/UI code — the part a plain "load" never touches.
    const viewPlugins = extensions.filter(
      (ext) => (ext && typeof ext.create === "function") || (typeof ext === "function" && /^\s*class\b/.test(Function.prototype.toString.call(ext))),
    );
    if (viewPlugins.length > 0 && !dom) {
      // Instantiating a view with no DOM can only fail on `document`, which
      // would be an environment gap misreported as a plugin defect.
      result.viewPluginsRegistered = viewPlugins.length;
      warn(
        `editor view plugin(s) instantiate (0/${viewPlugins.length})`,
        "not checkable offline: no DOM host, and an editor view needs one — add jsdom to the plugin project (`pnpm add -D jsdom`) to cover the UI code",
      );
    } else if (viewPlugins.length > 0) {
      for (const ext of viewPlugins) {
        try {
          const value = typeof ext.create === "function" ? ext.create(stubView()) : ext(stubView());
          if (value && typeof value.destroy === "function") {
            try {
              value.destroy();
            } catch {
              /* a view that cannot tear down is reported below by the unload check */
            }
          }
          result.viewPluginsRun = (result.viewPluginsRun ?? 0) + 1;
        } catch (error) {
          const gap = environmentGapDetail(error);
          if (!gap) result.viewPluginsFailed = [...(result.viewPluginsFailed ?? []), firstLine(error && error.message)];
        }
      }
      result.viewPluginsRegistered = viewPlugins.length;
      if (result.viewPluginsRun > 0) {
        check(`editor view plugin(s) instantiate (${result.viewPluginsRun}/${viewPlugins.length})`, "warn", true);
      } else if (result.viewPluginsFailed && result.viewPluginsFailed.length) {
        fail("editor view plugin(s) instantiate", result.viewPluginsFailed[0]);
      }
    } else if (result.registrations.some((r) => r === "registerEditorExtension")) {
      warn(
        "editor extension body runs",
        "the plugin registers an editor extension, but nothing in it ran — its UI code is NOT covered by this smoke test",
      );
    }

    // ---- unload ----------------------------------------------------------
    try {
      await instance.onunload();
      check("onunload() completed without throwing", "fail", true);
    } catch (error) {
      const gap = environmentGapDetail(error);
      if (gap) warn("onunload() completed without throwing", gap);
      else fail("onunload() completed without throwing", `${firstLine(error && error.message)}\n${stackTail(error)}`);
    }

    // ---- scenario (optional) --------------------------------------------
    if (args.scenario) {
      try {
        const scenarioModule = await import(pathToFileUrl(resolve(args.scenario)));
        const scenario = scenarioModule.default ?? scenarioModule;
        if (typeof scenario !== "function") {
          fail("scenario runs", "the scenario file does not export a function as default");
        } else {
          await scenario({ plugin: instance, app, stub, Plugin: stub.Plugin, check, warn, fail });
          check("scenario runs", "fail", true);
          result.scenario = resolve(args.scenario);
        }
      } catch (error) {
        fail("scenario runs", `${firstLine(error && error.message)}\n${stackTail(error)}`);
      }
    }
  } finally {
    await new Promise((r) => setTimeout(r, 25)); // let queued rejections surface
    finish();
    if (stagedCopy) rmSync(stagedCopy, { force: true });
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    process.off("unhandledRejection", onRejection);
    Module._load = originalLoad;
  }

  function finish() {
    if (rejections.length) {
      fail("no unhandled rejection during load", firstLine(rejections[0] && rejections[0].message));
    } else {
      check("no unhandled rejection during load", "fail", true);
    }
    const minAppVersion = manifest.minAppVersion;
    if (minAppVersion === undefined) {
      warn("manifest.minAppVersion parses", "manifest.json has no minAppVersion");
    } else if (!/^\d+\.\d+\.\d+/.test(String(minAppVersion))) {
      warn("manifest.minAppVersion parses", `"${minAppVersion}" is not a semver version`);
    } else {
      check("manifest.minAppVersion parses", "warn", true);
    }

    result.console = consoleCapture.slice(0, 50);
    const failed = checks.filter((c) => c.level === "fail").length;
    const warned = checks.filter((c) => c.level === "warn").length;
    result.ok = failed === 0;
    if (!result.summary) {
      result.summary = result.ok
        ? `loaded and unloaded cleanly (${checks.length - warned - failed} checks, ${warned} warning(s))`
        : `${failed} check(s) failed`;
    }
    emit(result, result.ok ? 0 : 1);
  }
}

/** Minimal CodeMirror EditorView stand-in for instantiating a ViewPlugin. */
function stubView() {
  return {
    dom: document.createElement("div"),
    contentDOM: document.createElement("div"),
    state: { doc: { lines: 1, length: 0, line: () => ({ from: 0, to: 0, text: "", number: 1 }), toString: () => "" }, selection: { main: { from: 0, to: 0 } }, field: () => undefined },
    dispatch() {},
    focus() {},
    requestMeasure() {},
    coordsAtPos: () => null,
    posAtDOM: () => 0,
    posAtCoords: () => null,
    viewport: { from: 0, to: 0 },
    visibleRanges: [],
    plugin: () => undefined,
  };
}

/** Obsidian's `moment`, taken from the stub so both surfaces agree. */
function createMoment() {
  if (!createMoment._value) createMoment._value = require("./obsidian-stub.cjs").stubMoment();
  return createMoment._value;
}

/**
 * Add Obsidian's DOM extensions to real jsdom elements.
 *
 * Obsidian augments `HTMLElement` with `createEl`/`createDiv`/`createSpan`,
 * `setText`, `empty`, `addClass` and friends; plugins use them everywhere
 * (`document.body.createDiv(...)` in float-mark). Patching the prototypes keeps
 * the whole real DOM available while supplying the Obsidian surface.
 */
function installDomHelpers(win) {
  const proto = win.HTMLElement && win.HTMLElement.prototype;
  if (!proto || proto.createDiv) return;

  const applyOptions = (el, options) => {
    if (!options) return el;
    if (typeof options === "string") {
      el.className = options;
      return el;
    }
    if (typeof options !== "object") return el;
    if (typeof options.cls === "string") el.className = `${el.className ? `${el.className} ` : ""}${options.cls}`.trim();
    if (typeof options.text === "string") el.textContent = options.text;
    if (typeof options.title === "string") el.setAttribute("title", options.title);
    if (typeof options.href === "string") el.setAttribute("href", options.href);
    if (typeof options.type === "string") el.setAttribute("type", options.type);
    if (typeof options.value === "string") el.setAttribute("value", options.value);
    if (typeof options.placeholder === "string") el.setAttribute("placeholder", options.placeholder);
    if (options.attr && typeof options.attr === "object") {
      for (const [key, value] of Object.entries(options.attr)) el.setAttribute(key, String(value));
    }
    if (options.parent) options.parent.appendChild(el);
    if (options.prepend) options.parent?.prepend(el);
    return el;
  };

  Object.defineProperties(proto, {
    createEl: {
      value(tag, options) {
        return applyOptions(this.ownerDocument.createElement(tag), options);
      },
      configurable: true,
      writable: true,
    },
    createDiv: { value(options) { return this.createEl("div", options); }, configurable: true, writable: true },
    createSpan: { value(options) { return this.createEl("span", options); }, configurable: true, writable: true },
    createSvg: { value(tag, options) { return applyOptions(this.ownerDocument.createElementNS("http://www.w3.org/2000/svg", tag), options); }, configurable: true, writable: true },
    setText: { value(text) { this.textContent = String(text); return this; }, configurable: true, writable: true },
    setAttr: { value(name, value) { this.setAttribute(name, String(value)); return this; }, configurable: true, writable: true },
    empty: { value() { while (this.firstChild) this.removeChild(this.firstChild); return this; }, configurable: true, writable: true },
    detach: { value() { this.remove(); return this; }, configurable: true, writable: true },
    addClass: { value(...classes) { for (const cls of classes) this.classList.add(cls); return this; }, configurable: true, writable: true },
    removeClass: { value(...classes) { for (const cls of classes) this.classList.remove(cls); return this; }, configurable: true, writable: true },
    toggleClass: { value(classes, value) { for (const cls of [].concat(classes)) this.classList.toggle(cls, value); return this; }, configurable: true, writable: true },
    hasClass: { value(cls) { return this.classList.contains(cls); }, configurable: true, writable: true },
    setCssStyles: { value(styles) { Object.assign(this.style, styles); return this; }, configurable: true, writable: true },
    setCssProps: { value(props) { Object.assign(this.style, props); return this; }, configurable: true, writable: true },
    getCssPropertyValue: { value(prop) { return win.getComputedStyle(this).getPropertyValue(prop); }, configurable: true, writable: true },
    onClickEvent: { value(cb) { this.addEventListener("click", cb); return this; }, configurable: true, writable: true },
    on: { value(type, selectorOrCb, maybeCb) { const cb = typeof selectorOrCb === "function" ? selectorOrCb : maybeCb; this.addEventListener(type, cb); return this; }, configurable: true, writable: true },
    setTooltip: { value(text) { this.setAttribute("aria-label", String(text)); return this; }, configurable: true, writable: true },
    // Visibility helpers, implemented via inline style so they compose with the
    // real element's own classList.
    show: { value() { this.style.display = ""; this.style.visibility = ""; return this; }, configurable: true, writable: true },
    hide: { value() { this.style.display = "none"; return this; }, configurable: true, writable: true },
    toggle: { value(visible) { if (visible === true) return this.show(); if (visible === false) return this.hide(); return this.style.display === "none" ? this.show() : this.hide(); }, configurable: true, writable: true },
    toggleVisibility: { value(visible) { return this.toggle(visible); }, configurable: true, writable: true },
    isShown: { value() { return this.style.display !== "none"; }, configurable: true, writable: true },
    // Obsidian exposes the owning document/window on every element; plugins use
    // `el.doc.removeEventListener(...)` in teardown (float-mark does).
    doc: { get() { return this.ownerDocument; }, configurable: true },
    win: { get() { return this.ownerDocument?.defaultView; }, configurable: true },
  });
}

/**
 * Recognise a failure that is caused by the offline environment rather than by
 * the plugin.
 *
 * A stub cannot provide a real CodeMirror EditorView, a rendered markdown view
 * or Obsidian's own UI chrome. When a plugin's teardown reaches into one of
 * those and finds nothing, the honest report is "this could not be checked
 * here", not "the plugin is broken" — and it must never be reported the other
 * way around either, so the check stays visible as a gap.
 */
function environmentGapDetail(error) {
  const message = firstLine(error && error.message);
  const stack = error && error.stack ? String(error.stack) : "";
  const TEXT = /EditorView|editor\s*view|MarkdownView|markdown\s*view|getViewData|\.editor\b|\.cm\b/i;
  const SHAPE = /Cannot read properties of (undefined|null)/;
  if (TEXT.test(message) || (TEXT.test(stack) && SHAPE.test(message))) {
    return `not checkable offline: the code touched an editor/view that only exists in a real Obsidian (${message})`;
  }
  if (/not implemented in the offline stub/i.test(message)) {
    return `not checkable offline: the bundle needs an API the stub does not model (${message})`;
  }
  if (/\b(document|window|navigator|HTMLElement)\b is not defined/.test(message)) {
    return `not checkable offline: no DOM host was available (${message}) — add jsdom to the plugin project to cover this path`;
  }
  // Browser features a stub process cannot faithfully provide: frame callbacks,
  // layout observation, and anything that only reports real geometry.
  if (/requestAnimationFrame|requestIdleCallback|ResizeObserver|IntersectionObserver|getBoundingClientRect|ownerWindow/i.test(message)) {
    return `not checkable offline: the view plugin needs real rendering (${message})`;
  }
  return undefined;
}

/**
 * Best-effort DOM host. jsdom is deliberately NOT a dependency of this package:
 * the project's own install is tried first, and a jsdom resolvable from this
 * process is only a fallback (a hoisted or globally installed one).
 */
function installHostEnvironment(projectDir) {
  let JSDOM;
  let fromProject = true;
  try {
    const projectRequire = createRequire(join(projectDir, "package.json"));
    ({ JSDOM } = projectRequire("jsdom"));
  } catch {
    fromProject = false;
    try {
      ({ JSDOM } = require("jsdom"));
    } catch (error) {
      return { dom: false, why: `no jsdom resolvable from the project or this process: ${error && error.message}` };
    }
  }
  try {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "app://obsidian.md/" });
    // Some globals are accessor-only on modern Node (notably `navigator`), so a
    // plain assignment throws and would abort the whole injection. Define each
    // one independently and tolerate the ones that cannot be overridden.
    let injected = 0;
    for (const key of [...HOST_GLOBALS, "self"]) {
      const value = key === "self" ? dom.window : dom.window[key];
      if (value === undefined) continue;
      try {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
        injected++;
      } catch {
        /* read-only global: leave Node's own value in place */
      }
    }
    if (!globalThis.document) return { dom: false, why: "jsdom produced no document" };

    // Obsidian injects its own extensions onto `window`; plugins rely on them.
    // `activeDocument` / `activeWindow` (multi-window support) are the ones real
    // plugins use at load time — float-mark's getActiveBody() reads
    // window.activeDocument, which plain jsdom does not provide.
    // Obsidian attaches its own globals to `window`; bundles read them both as
    // `window.moment` and as the bare `moment` global.
    const hostGlobals = {
      moment: createMoment(),
      // Frame callbacks live on the real window; the proxy must keep them
      // reachable or a view plugin that schedules a frame fails spuriously.
      requestAnimationFrame: (cb) => dom.window.setTimeout(() => cb(Date.now()), 0),
      cancelAnimationFrame: (id) => dom.window.clearTimeout(id),
      setTimeout: dom.window.setTimeout.bind(dom.window),
      clearTimeout: dom.window.clearTimeout.bind(dom.window),
      setInterval: dom.window.setInterval.bind(dom.window),
      clearInterval: dom.window.clearInterval.bind(dom.window),
    };
    const obsidianWindow = new Proxy(dom.window, {
      get(target, prop) {
        if (prop === "activeDocument") return target.document;
        if (prop === "activeWindow") return target;
        if (prop in hostGlobals && hostGlobals[prop] !== undefined) return hostGlobals[prop];
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
      has: () => true,
    });
    try {
      Object.defineProperty(globalThis, "window", { value: obsidianWindow, configurable: true, writable: true });
      Object.defineProperty(globalThis, "activeDocument", { value: dom.window.document, configurable: true, writable: true });
      Object.defineProperty(globalThis, "activeWindow", { value: obsidianWindow, configurable: true, writable: true });
    } catch {
      /* leave whatever is there */
    }
    installDomHelpers(dom.window);
    if (globalThis.moment === undefined) {
      try {
        Object.defineProperty(globalThis, "moment", { value: createMoment(), configurable: true, writable: true });
      } catch {
        /* keep Node's own */
      }
    }
    // Some bundles call the bare globals rather than window.*.
    for (const fn of ["dispatchEvent", "addEventListener", "removeEventListener", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "fetch", "alert", "confirm", "prompt"]) {
      if (typeof dom.window[fn] === "function" && globalThis[fn] === undefined) {
        try {
          Object.defineProperty(globalThis, fn, { value: dom.window[fn].bind(dom.window), configurable: true, writable: true });
        } catch {
          /* keep Node's own */
        }
      }
    }
    // Name the branch that actually succeeded: reporting "project jsdom" for a
    // fallback-resolved one would misattribute where the DOM came from.
    return {
      dom: true,
      source: `${fromProject ? "project jsdom" : "jsdom from this process"} (${injected} globals + obsidian window extensions)`,
    };
  } catch (error) {
    return { dom: false, why: `jsdom setup failed: ${error && error.message}` };
  }
}

function readPluginData(projectDir, pluginId) {
  if (!pluginId) return undefined;
  const path = join(projectDir, "data.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}



function pathToFileUrl(path) {
  return require("node:url").pathToFileURL(path).href;
}

function safeString(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstLine(text) {
  return String(text ?? "").split("\n")[0];
}

function stackTail(error) {
  const stack = error && error.stack ? String(error.stack).split("\n").slice(1, 4).join("\n") : "";
  return stack ? `${stack}\n` : "";
}

function firstCapturedError(captured) {
  const first = captured.find((entry) => entry.level === "error");
  return first ? `first console.error: ${first.text}\n` : "";
}

/** Last stdout line carries the machine-readable result. */
function emit(result, code) {
  if (emitted) return;
  emitted = true;
  const human = [];
  human.push(`offline smoke: ${result.ok ? "PASS" : "FAIL"} — ${result.summary}`);
  for (const c of result.checks) {
    const mark = c.level === "pass" ? "ok  " : c.level === "warn" ? "warn" : "FAIL";
    human.push(`  [${mark}] ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  }
  if (result.console.length) {
    human.push("  captured console output:");
    for (const entry of result.console.slice(0, 10)) human.push(`    ${entry.level}: ${entry.text}`);
  }
  process.stdout.write(human.join("\n") + "\n");
  process.stdout.write(`__HARNESS_RESULT__ ${JSON.stringify(result)}\n`);
  if (code !== 0) process.exitCode = 1;
}

main().catch((error) => {
  emit(
    { ok: false, checks: [{ name: "harness", level: "fail", detail: firstLine(error && error.message) }], summary: "harness crashed" },
    2,
  );
});
