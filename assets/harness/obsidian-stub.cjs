// Offline Obsidian API stub for smoke-loading a plugin bundle in plain Node.
//
// Scope (DESIGN.md §4.3): enough for a real plugin to LOAD — a `Plugin` base
// that records registrations, a minimal App, the globals Obsidian injects, and
// clear failures for everything else. It does not emulate Obsidian; anything
// unmodelled throws `Not implemented in the offline stub: <name>` so a missing
// stub surfaces as a named gap instead of "undefined is not a function".
//
// CommonJS on purpose: the harness patches `require("obsidian")`, and this file
// is loaded by that patch.

"use strict";

/** Every registration the base class records, so the harness can assert cleanup. */
/** DOM listeners registered by each plugin instance, for unload cleanup. */
const domListenerRegistry = new WeakMap();

const REGISTER_METHODS = [
  "addCommand",
  "addRibbonIcon",
  "addStatusBarItem",
  "addSettingTab",
  "registerView",
  "registerEvent",
  "registerDomEvent",
  "registerInterval",
  "registerEditorExtension",
  "registerMarkdownPostProcessor",
  "registerEditorSuggest",
  "registerHoverLinkSource",
  "registerObsidianProtocolHandler",
  "registerExtensions",
];

class Component {
  constructor() {
    this._loaded = false;
    this._children = [];
    /** Keys of everything this component registered, for the cleanup assertion. */
    this._registrations = [];
  }

  onload() {}
  onunload() {}

  load() {
    if (this._loaded) return;
    this._loaded = true;
    this.onload();
  }

  unload() {
    if (!this._loaded) return;
    this.onunload();
    this._unloadDomEvents?.();
    // Obsidian detaches registered resources on unload; recording keeps the
    // count observable so the harness can flag a plugin that never cleans up.
    for (const child of this._children) {
      try {
        child.unload();
      } catch {
        /* a failing child must not mask the parent's result */
      }
    }
    this._loaded = false;
  }

  addChild(child) {
    this._children.push(child);
    return child;
  }

  removeChild(child) {
    this._children = this._children.filter((c) => c !== child);
    return child;
  }

  register(cb) {
    this._registrations.push("register");
    return cb;
  }

  registerEvent() {
    this._registrations.push("registerEvent");
  }


  registerInterval(id) {
    this._registrations.push("registerInterval");
    return id;
  }

  registerScopeEvent() {
    this._registrations.push("registerScopeEvent");
  }
}

class Events {
  constructor() {
    this._handlers = new Map();
  }
  on(name, cb) {
    const list = this._handlers.get(name) ?? [];
    list.push(cb);
    this._handlers.set(name, list);
    return { name, cb };
  }
  off(name, cb) {
    const list = this._handlers.get(name) ?? [];
    this._handlers.set(
      name,
      list.filter((entry) => entry !== cb),
    );
  }
  /** Obsidian pairs `on` with `offref(ref)`; both spellings appear in the wild. */
  offref(ref) {
    if (!ref) return;
    const name = typeof ref === "string" ? ref : ref.name;
    const cb = typeof ref === "string" ? undefined : ref.cb;
    if (!name) return;
    if (!cb) return this._handlers.delete(name);
    const list = this._handlers.get(name) ?? [];
    this._handlers.set(
      name,
      list.filter((entry) => entry !== cb),
    );
  }
  tryTrigger(name, ...args) {
    if (!this._handlers.has(name)) return false;
    this.trigger(name, ...args);
    return true;
  }
  trigger(name, ...args) {
    for (const cb of this._handlers.get(name) ?? []) cb(...args);
  }
}

class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    /** Data returned by loadData(); the harness seeds it from data.json. */
    this._stubData = undefined;
    this._savedData = [];
  }

  async loadData() {
    return this._stubData;
  }

  async saveData(data) {
    this._savedData.push(data);
  }

  addCommand(command) {
    this._registrations.push(`addCommand:${command && command.id}`);
    this.app.commands.commands[command.id] = command;
    return command;
  }

  addRibbonIcon(icon, title, callback) {
    this._registrations.push(`addRibbonIcon:${title}`);
    const el = createStubElement("div");
    el.setAttribute("aria-label", title);
    if (typeof callback === "function") el.addEventListener("click", callback);
    this.app.workspace.ribbonIcons.push({ icon, title, el });
    return el;
  }

  addStatusBarItem() {
    this._registrations.push("addStatusBarItem");
    return createStubElement("div");
  }

  addSettingTab(tab) {
    this._registrations.push("addSettingTab");
    this.app.setting.pluginTabs.push(tab);
    return tab;
  }

  registerView(type, factory) {
    this._registrations.push(`registerView:${type}`);
    this.app.workspace.viewFactories[type] = factory;
  }

  registerEvent(eventRef) {
    this._registrations.push("registerEvent");
    return eventRef;
  }

  registerDomEvent(el, type, cb, options) {
    this._registrations.push("registerDomEvent");
    // Registration happens on real (jsdom) elements and on the plain objects the
    // stub hands out for status-bar/ribbon items. Remember every pair so cleanup
    // mirrors Obsidian without depending on which kind it was.
    if (el && typeof el.addEventListener === "function") el.addEventListener(type, cb, options);
    domListenerRegistry.set(this, [...(domListenerRegistry.get(this) ?? []), { el, type, cb, options }]);
  }

  /** Obsidian removes registered DOM listeners on unload. */
  _unloadDomEvents() {
    for (const { el, type, cb } of domListenerRegistry.get(this) ?? []) {
      if (el && typeof el.removeEventListener === "function") el.removeEventListener(type, cb);
    }
  }

  registerInterval(id) {
    this._registrations.push("registerInterval");
    return id;
  }

  registerMarkdownPostProcessor(processor) {
    this._registrations.push("registerMarkdownPostProcessor");
    this.app.workspace.markdownPostProcessors.push(processor);
  }

  registerEditorSuggest() {
    this._registrations.push("registerEditorSuggest");
  }

  registerMarkdownCodeBlockProcessor(language, handler, sortOrder) {
    this._registrations.push(`registerMarkdownCodeBlockProcessor:${language}`);
    this.app.workspace.markdownCodeBlockProcessors[language] = handler;
    this.app.workspace.markdownCodeBlockProcessorSortOrders[language] = sortOrder;
  }

  registerMarkdownPostProcessor(processor, sortOrder) {
    this._registrations.push("registerMarkdownPostProcessor");
    this.app.workspace.markdownPostProcessors.push({ processor, sortOrder });
  }

  registerHoverLinkSource(id, info) {
    this._registrations.push(`registerHoverLinkSource:${id}`);
    this.app.workspace.hoverLinkSources[id] = info;
  }

  registerObsidianProtocolHandler(action, handler) {
    this._registrations.push(`registerObsidianProtocolHandler:${action}`);
    this.app.workspace.protocolHandlers[action] = handler;
  }

  registerExtensions(extensions, viewType) {
    this._registrations.push("registerExtensions");
    this.app.workspace.editorExtensions.push({ extensions, viewType });
  }

  registerEditorExtension(extension) {
    this._registrations.push("registerEditorExtension");
    this.app.workspace.editorExtensions.push(extension);
    return extension;
  }

  registerBasesView() {
    this._registrations.push("registerBasesView");
  }

}

class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createStubElement("div");
  }
  display() {}
  hide() {}
}

class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.containerEl = createStubElement("div");
    this.contentEl = createStubElement("div");
  }
  getViewType() {
    return "stub-view";
  }
  getDisplayText() {
    return "Stub view";
  }
  getIcon() {
    return "file";
  }
}

class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = createStubElement("div");
    this.contentEl = createStubElement("div");
    this.titleEl = createStubElement("div");
    this.modalEl = createStubElement("div");
    this.scope = { register: () => ({}) };
  }
  open() {
    this.onOpen?.();
    this.app.workspace.openModals.push(this);
  }
  close() {
    this.onClose?.();
    this.app.workspace.openModals = this.app.workspace.openModals.filter((m) => m !== this);
  }
  onOpen() {}
  onClose() {}
  setTitle(title) {
    this.titleEl.textContent = String(title);
    return this;
  }
  setContent(content) {
    this.contentEl.textContent = content;
    return this;
  }
  addAction() {
    return this;
  }
  addButton() {
    return this;
  }
}

class Notice {
  constructor(message) {
    this.message = message;
    Notice.instances.push(message);
  }
}
Notice.instances = [];

class Setting {
  constructor(containerEl) {
    this.containerEl = containerEl ?? createStubElement("div");
    this.components = [];
    this.name = "";
    this.desc = "";
  }
  setName(name) {
    this.name = name;
    return this;
  }
  setDesc(desc) {
    this.desc = desc;
    return this;
  }
  addText(cb) {
    const text = makeTextComponent();
    cb(text);
    this.components.push(text);
    return this;
  }
  addTextArea(cb) {
    const text = makeTextComponent();
    cb(text);
    this.components.push(text);
    return this;
  }
  addToggle(cb) {
    const toggle = { value: false, setValue: (v) => ((toggle.value = v), toggle), onChange: () => toggle, setDisabled: () => toggle };
    cb(toggle);
    this.components.push(toggle);
    return this;
  }
  addDropdown(cb) {
    const dropdown = { value: "", addOption: () => dropdown, addOptions: () => dropdown, setValue: (v) => ((dropdown.value = v), dropdown), onChange: () => dropdown, setDisabled: () => dropdown };
    cb(dropdown);
    this.components.push(dropdown);
    return this;
  }
  addSlider(cb) {
    const slider = { value: 0, setLimits: () => slider, setValue: (v) => ((slider.value = v), slider), setDynamicTooltip: () => slider, onChange: () => slider };
    cb(slider);
    this.components.push(slider);
    return this;
  }
  addButton(cb) {
    const button = { setButtonText: () => button, setCta: () => button, setIcon: () => button, onClick: () => button, setDisabled: () => button, setTooltip: () => button };
    cb(button);
    this.components.push(button);
    return this;
  }
  addExtraButton(cb) {
    return this.addButton(cb);
  }
  setHeading() {
    return this;
  }
}

function makeTextComponent() {
  const component = {
    value: "",
    inputEl: createStubElement("input"),
    setPlaceholder: () => component,
    setValue: (v) => ((component.value = v), component),
    getValue: () => component.value,
    onChange: () => component,
    setDisabled: () => component,
  };
  return component;
}

/** Minimal element backed by a plain object; enough for load-time DOM work. */
function createStubElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    textContent: "",
    innerHTML: "",
    empty() {},
    createEl(childTag, options) {
      const child = createStubElement(childTag);
      if (options && typeof options === "object") {
        if (typeof options.text === "string") child.textContent = options.text;
        if (typeof options.cls === "string") child.className = options.cls;
        if (typeof options.attr === "object" && options.attr) Object.assign(child.attributes, options.attr);
      }
      el.children.push(child);
      return child;
    },
    createDiv(options) {
      return el.createEl("div", options);
    },
    createSpan(options) {
      return el.createEl("span", options);
    },
    setText(text) {
      el.textContent = String(text);
      return el;
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    getAttribute(name) {
      return el.attributes[name];
    },
    removeAttribute(name) {
      delete el.attributes[name];
    },
    addClass(cls) {
      el.className = `${el.className ?? ""} ${cls}`.trim();
    },
    removeClass(cls) {
      el.className = String(el.className ?? "")
        .split(/\s+/)
        .filter((c) => c && c !== cls)
        .join(" ");
    },
    toggleClass() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    remove() {},
    detach() {},
    focus() {},
    blur() {},
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttr(name, value) {
      el.attributes[name] = String(value);
      return el;
    },
  };
  return el;
}

/** Path helpers Obsidian exports. */
class TAbstractFile {
  constructor(path, name) {
    this.path = path;
    this.name = name ?? String(path).split("/").pop();
    this.parent = null;
  }
}

class TFile extends TAbstractFile {
  constructor(path, stat) {
    super(path);
    this.extension = String(path).split(".").pop() ?? "";
    this.basename = this.name.replace(/\.[^.]+$/, "");
    this.stat = stat ?? { ctime: 0, mtime: 0, size: 0 };
  }
}

class TFolder extends TAbstractFile {
  constructor(path) {
    super(path);
    this.children = [];
    this.isRoot = () => path === "/" || path === "";
  }
}

class Vault extends Events {
  constructor() {
    super();
    this._files = new Map();
    this._root = new TFolder("/");
  }
  getName() {
    return "offline-stub-vault";
  }
  getRoot() {
    return this._root;
  }
  getFiles() {
    return [...this._files.values()];
  }
  getMarkdownFiles() {
    return this.getFiles().filter((f) => f.extension === "md");
  }
  getAbstractFileByPath(path) {
    return this._files.get(path) ?? null;
  }
  async read() {
    return "";
  }
  async cachedRead(file) {
    return this._files.get(file?.path)?.content ?? "";
  }
  async create() {
    return undefined;
  }
  async modify() {}
  async process() {}
  async delete() {}
  async trash() {}
  async rename() {}
  async createFolder() {
    return undefined;
  }
  adapter = {
    basePath: "/offline-stub-vault",
    getBasePath: () => "/offline-stub-vault",
    exists: async () => false,
    read: async () => "",
    write: async () => {},
    mkdir: async () => {},
  };
}

class WorkspaceLeaf {
  constructor() {
    this.view = null;
  }
  async setViewState() {}
  async openFile() {
    return undefined;
  }
  async detach() {}
}

class Workspace extends Events {
  constructor() {
    super();
    this.ribbonIcons = [];
    this.viewFactories = {};
    this.editorExtensions = [];
    this.markdownPostProcessors = [];
    this.markdownCodeBlockProcessors = {};
    this.markdownCodeBlockProcessorSortOrders = {};
    this.hoverLinkSources = {};
    this.protocolHandlers = {};
    this.openModals = [];
    this.activeLeaf = new WorkspaceLeaf();
    this.layoutReady = true;
  }
  getLeaf() {
    return new WorkspaceLeaf();
  }
  getLeavesOfType() {
    return [];
  }
  getActiveViewOfType() {
    return null;
  }
  getActiveFile() {
    return null;
  }
  onLayoutReady(cb) {
    cb();
  }
  async revealLeaf() {}
  iterateAllLeaves() {}
  getRightLeaf() {
    return new WorkspaceLeaf();
  }
  getLeftLeaf() {
    return new WorkspaceLeaf();
  }
  detachLeavesOfType() {}
  async setActiveLeaf() {}
}

/** Build the stub module object Obsidian would export. */
function createObsidianStub(options = {}) {
  const workspace = new Workspace();
  const vault = new Vault();

  const app = {
    appId: "offline-stub",
    vault,
    workspace,
    metadataCache: Object.assign(new Events(), {
      getFileCache: () => null,
      getFirstLinkpathDest: () => null,
      getCache: () => null,
      resolvedLinks: {},
      unresolvedLinks: {},
      fileToLinktext: () => "",
      onCleanCache: () => ({}),
    }),
    fileManager: Object.assign(new Events(), {
      generateMarkdownLink: () => "",
      processFrontMatter: async () => {},
      trashFile: async () => {},
      renameFile: async () => {},
      getNewFileParent: () => new TFolder("/"),
      promptForFileDeletion: async () => {},
    }),
    commands: {
      commands: {},
      listCommands: () => Object.values(app.commands.commands),
      addCommand: (cmd) => (app.commands.commands[cmd.id] = cmd),
      removeCommand: (id) => delete app.commands.commands[id],
      executeCommandById: (id) => Boolean(app.commands.commands[id]),
      findCommand: (id) => app.commands.commands[id],
    },
    setting: { pluginTabs: [], open: () => {}, openTabById: () => {}, addSettingTab: (tab) => app.setting.pluginTabs.push(tab) },
    keymap: { pushScope: () => {}, popScope: () => {} },
    scope: { register: () => ({}) },
    lastEvent: null,
    internalPlugins: { getEnabledPluginById: () => null, plugins: {} },
    plugins: {
      plugins: {},
      manifests: {},
      enabledPlugins: new Set(),
      isEnabled: () => true,
      loadManifests: async () => {},
      getPlugin: (id) => app.plugins.plugins[id] ?? null,
      getEnabledPluginById: (id) => app.plugins.plugins[id] ?? null,
      enablePlugin: async () => {},
      disablePlugin: async () => {},
      loadPlugin: async () => {},
      unloadPlugin: async () => {},
    },
    dragManager: { draggable: () => ({}) },
    loadLocalStorage: () => null,
    saveLocalStorage: () => {},
    hotkeyManager: { getHotkeys: () => [], printHotkeyForCommand: () => "" },
    getObsidianUrl: () => "",
    secretStorage: { getSecret: async () => null, setSecret: async () => {} },
  };

  const requestUrl = async () => ({ status: 200, text: "", json: {}, arrayBuffer: new ArrayBuffer(0) });

  const stub = {
    App: function App() {},
    Plugin,
    PluginSettingTab,
    ItemView,
    Modal,
    Notice,
    Setting,
    Component,
    Events,
    TAbstractFile,
    TFile,
    TFolder,
    Vault,
    Workspace,
    WorkspaceLeaf,
    MarkdownView: class MarkdownView extends ItemView {
      getMode() {
        return "source";
      }
    },
    MarkdownRenderChild: class MarkdownRenderChild extends Component {
      constructor(containerEl) {
        super();
        this.containerEl = containerEl;
      }
    },
    FileSystemAdapter: class FileSystemAdapter {
      getBasePath() {
        return "/offline-stub-vault";
      }
      static getBasePath() {
        return "/offline-stub-vault";
      }
    },
    Editor: function Editor() {},
    Platform: { isDesktop: true, isMobile: false, isDesktopApp: true, isMobileApp: false, isIosApp: false, isAndroidApp: false },
    moment: stubMoment(),
    normalizePath: (path) => String(path).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
    addIcon: (id) => {
      stub.__icons = stub.__icons ?? {};
      stub.__icons[id] = true;
    },
    setIcon: () => {},
    getIcon: () => null,
    getLanguage: () => "en",
    requestUrl,
    prepareFuzzySearch: () => () => null,
    prepareSimpleSearch: () => () => null,
    debounce: (fn) => {
      const wrapped = (...args) => fn(...args);
      wrapped.cancel = () => {};
      wrapped.run = (...args) => fn(...args);
      return wrapped;
    },
    sanitizeHTMLToDom: () => createStubElement("div"),
    htmlToMarkdown: (html) => String(html),
    parseLinktext: (linktext) => ({ path: linktext, subpath: "" }),
    getLinkpath: (link) => String(link),
    stripHeading: (heading) => String(heading),
    arrayBufferToBase64: () => "",
    base64ToArrayBuffer: () => new ArrayBuffer(0),
    stringifyYaml: () => "",
    parseYaml: () => ({}),
    apiVersion: "1.8.0",
    /** Version gate plugins use to branch on Obsidian features. */
    requireApiVersion: (version) => {
      const want = String(version).split(".").map((n) => Number.parseInt(n, 10) || 0);
      const have = "1.8.0".split(".").map((n) => Number.parseInt(n, 10) || 0);
      for (let i = 0; i < 3; i++) {
        if ((have[i] ?? 0) > (want[i] ?? 0)) return true;
        if ((have[i] ?? 0) < (want[i] ?? 0)) return false;
      }
      return true;
    },
    getAllTags: () => [],
    getFrontMatterInfo: () => ({ exists: false, frontmatter: "", contentStart: 0, from: 0, to: 0 }),
    parseFrontMatterAliases: () => null,
    parseFrontMatterTags: () => null,
    parseFrontMatterEntry: () => null,
    parseFrontMatterStringArray: () => null,
    renderMath: () => createStubElement("span"),
    renderResults: () => {},
    loadMathJax: async () => {},
    loadPrism: async () => {},
    finishRenderMath: async () => {},
    MarkdownRenderer: {
      render: async () => {},
      renderMarkdown: async () => {},
    },
    MarkdownPreviewView: class MarkdownPreviewView extends ItemView {},
    ToggleComponent: class ToggleComponent {},
    TextComponent: class TextComponent {},
    DropdownComponent: class DropdownComponent {},
    SliderComponent: class SliderComponent {},
    ButtonComponent: class ButtonComponent {},
    ExtraButtonComponent: class ExtraButtonComponent {},
    EditorSuggest: class EditorSuggest {
      constructor(app) {
        this.app = app;
        this.scope = { register: () => ({}) };
        this.limit = 50;
      }
      setInstructions() {}
      close() {}
      open() {}
      getSuggestions() {
        return [];
      }
      renderSuggestion() {}
      selectSuggestion() {}
    },
    AbstractInputSuggest: class AbstractInputSuggest {
      constructor(app, inputEl) {
        this.app = app;
        this.inputEl = inputEl;
      }
      close() {}
      open() {}
      setValue() {}
      getValue() {
        return "";
      }
      onSelect() {}
    },
    FuzzySuggestModal: class FuzzySuggestModal extends Modal {
      constructor(app) {
        super(app);
        this.limit = 50;
      }
      getItems() {
        return [];
      }
      getItemText(item) {
        return String(item);
      }
      onChooseItem() {}
      setPlaceholder() {}
    },
    SuggestModal: class SuggestModal extends Modal {
      constructor(app) {
        super(app);
        this.limit = 50;
      }
      getSuggestions() {
        return [];
      }
      renderSuggestion() {}
      onChooseSuggestion() {}
      setPlaceholder() {}
    },
    Scope: class Scope {
      register() {
        return {};
      }
    },
    Keymap: { isModEvent: () => false, isModPressed: () => false },
    posToOffset: () => 0,
    offsetToPos: () => ({ line: 0, ch: 0 }),
    __app: app,
    __workspace: workspace,
    __vault: vault,
    __createElement: createStubElement,
  };

  // Unknown exports must fail loudly rather than resolve to undefined.
  return new Proxy(stub, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "symbol") return undefined;
      return function notImplemented() {
        throw new Error(`Not implemented in the offline stub: ${String(prop)}`);
      };
    },
    has: () => true,
  });
}

/** A tiny moment stand-in: Obsidian injects the real one as a global. */
function stubMoment() {
  const moment = (input) => ({
    format: () => String(input ?? ""),
    toISOString: () => new Date(input ?? Date.now()).toISOString(),
    isValid: () => true,
    valueOf: () => new Date(input ?? Date.now()).getTime(),
    add: () => moment(input),
    subtract: () => moment(input),
    startOf: () => moment(input),
    endOf: () => moment(input),
    clone: () => moment(input),
    locale: () => moment(input),
  });
  moment.locale = () => "en";
  moment.utc = moment;
  moment.duration = () => ({ asDays: () => 0, asHours: () => 0, humanize: () => "" });
  moment.isMoment = () => false;
  return moment;
}

module.exports = {
  createObsidianStub,
  createStubElement,
  Plugin,
  Component,
  Notice,
  REGISTER_METHODS,
  stubMoment,
};
