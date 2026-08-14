import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    for (const value of values) this.values.add(value);
  }

  remove(...values) {
    for (const value of values) this.values.delete(value);
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    const enabled = force == null ? !this.values.has(value) : force;
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.hidden = false;
    this.isConnected = false;
    this.listeners = new Map();
    this.queries = new Map();
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
      removeProperty(name) {
        delete this[name];
      },
    };
    this.rect = { left: 0, top: 0, width: 286, height: 200 };
    this.textContent = "";
    this.title = "";
  }

  set className(value) {
    this.classList = new FakeClassList();
    this.classList.add(...String(value).split(/\s+/).filter(Boolean));
  }

  set innerHTML(value) {
    this.markup = value;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  append(...children) {
    this.children.push(...children);
    for (const child of children) child.isConnected = this.isConnected;
  }

  replaceChildren(...children) {
    this.children = children;
    for (const child of children) child.isConnected = this.isConnected;
  }

  attachShadow() {
    const shadow = new FakeElement("shadow-root");
    this.shadowRoot = shadow;
    return shadow;
  }

  querySelector(selector) {
    if (!this.queries.has(selector)) {
      this.queries.set(selector, new FakeElement(selector));
    }
    return this.queries.get(selector);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  dispatch(name, overrides = {}) {
    this.listeners.get(name)?.({
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      preventDefault() {},
      stopPropagation() {},
      target: this,
      ...overrides,
    });
  }

  closest(selector) {
    return this.tagName === selector ? this : null;
  }

  setPointerCapture() {}

  releasePointerCapture() {}

  getBoundingClientRect() {
    const left = Number.parseFloat(this.style.left) || this.rect.left;
    const top = Number.parseFloat(this.style.top) || this.rect.top;
    return {
      left,
      top,
      width: this.rect.width,
      height: this.rect.height,
      right: left + this.rect.width,
      bottom: top + this.rect.height,
    };
  }

  click() {
    this.listeners.get("click")?.({
      preventDefault() {},
      stopPropagation() {},
      target: this,
    });
  }

  animate() {
    return { cancel() {} };
  }

  remove() {
    this.isConnected = false;
  }

  get offsetWidth() {
    return 0;
  }
}

test("native hosts can collapse the meter and receive layout changes", async () => {
  const source = (
    await readFile(new URL("../runtime/token-meter-ui.js", import.meta.url), "utf8")
  ).replace("__TOKEN_METER_CSS_JSON__", JSON.stringify(""));
  const created = [];
  const documentElement = new FakeElement("html");
  documentElement.isConnected = true;
  const layoutMessages = [];
  const window = {
    webkit: {
      messageHandlers: {
        tokenMeterLayout: {
          postMessage(value) {
            layoutMessages.push(value);
          },
        },
      },
    },
  };
  const context = vm.createContext({
    document: {
      createElement(tagName) {
        const element = new FakeElement(tagName);
        created.push(element);
        return element;
      },
      documentElement,
    },
    window,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    clearTimeout() {},
    setTimeout() {},
  });

  vm.runInContext(source, context);
  const card = created.find((element) => element.tagName === "section");
  const toggle = card.querySelector(".collapse-toggle");

  window.__tokenMeter.configure({ collapsible: true, collapsed: true });
  assert.equal(toggle.hidden, false);
  assert.equal(card.classList.contains("collapsed"), true);
  assert.equal(layoutMessages.at(-1).collapsed, true);

  toggle.click();
  assert.equal(card.classList.contains("collapsed"), false);
  assert.equal(layoutMessages.at(-1).collapsed, false);

  window.__tokenMeter.configure({ collapsible: false, collapsed: true });
  assert.equal(toggle.hidden, true);
  assert.equal(card.classList.contains("collapsed"), false);
});

test("injected hosts can drag and persist the compact meter layout", async () => {
  const source = (
    await readFile(new URL("../runtime/token-meter-ui.js", import.meta.url), "utf8")
  ).replace("__TOKEN_METER_CSS_JSON__", JSON.stringify(""));
  const created = [];
  const documentElement = new FakeElement("html");
  documentElement.isConnected = true;
  const stored = new Map();
  const window = {
    innerWidth: 1_200,
    innerHeight: 800,
    addEventListener() {},
    localStorage: {
      getItem(key) {
        return stored.get(key) ?? null;
      },
      setItem(key, value) {
        stored.set(key, value);
      },
    },
  };
  const context = vm.createContext({
    document: {
      createElement(tagName) {
        const element = new FakeElement(tagName);
        created.push(element);
        return element;
      },
      documentElement,
    },
    window,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    performance: { now: () => 0 },
    requestAnimationFrame(callback) {
      callback?.(0);
    },
    clearTimeout() {},
    setTimeout() {},
  });

  vm.runInContext(source, context);
  const host = created.find((element) => element.tagName === "div");
  host.rect = { left: 900, top: 600, width: 286, height: 180 };
  const card = created.find((element) => element.tagName === "section");
  const header = card.querySelector(".meter-header");
  const toggle = card.querySelector(".collapse-toggle");

  window.__tokenMeter.configure({
    collapsible: true,
    draggable: true,
    storageKey: "token-meter:codex-layout",
  });
  header.dispatch("pointerdown", { clientX: 950, clientY: 620 });
  header.dispatch("pointermove", { clientX: 700, clientY: 400 });
  header.dispatch("pointerup", { clientX: 700, clientY: 400 });

  assert.equal(host.style.left, "650px");
  assert.equal(host.style.top, "380px");

  const interactiveTarget = {
    closest(selector) {
      return selector.includes("button") ? this : null;
    },
  };
  header.dispatch("pointerdown", {
    target: interactiveTarget,
    clientX: 700,
    clientY: 400,
  });
  header.dispatch("pointermove", {
    target: interactiveTarget,
    clientX: 500,
    clientY: 200,
  });
  header.dispatch("pointerup", {
    target: interactiveTarget,
    clientX: 500,
    clientY: 200,
  });
  assert.equal(host.style.left, "650px");
  assert.equal(host.style.top, "380px");

  toggle.click();
  const saved = JSON.parse(stored.get("token-meter:codex-layout"));
  assert.equal(saved.collapsed, true);
  assert.equal(saved.left, 650);
  assert.equal(saved.top, 380);
});

test("expanded hosts render Session skill status lights", async () => {
  const source = (
    await readFile(new URL("../runtime/token-meter-ui.js", import.meta.url), "utf8")
  ).replace("__TOKEN_METER_CSS_JSON__", JSON.stringify(""));
  const created = [];
  const documentElement = new FakeElement("html");
  documentElement.isConnected = true;
  const window = {
    innerWidth: 1_200,
    innerHeight: 800,
    addEventListener() {},
    localStorage: { getItem() { return null; }, setItem() {} },
  };
  const context = vm.createContext({
    document: {
      createElement(tagName) {
        const element = new FakeElement(tagName);
        created.push(element);
        return element;
      },
      documentElement,
    },
    window,
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    clearTimeout() {},
    setTimeout() {},
  });

  vm.runInContext(source, context);
  const card = created.find((element) => element.tagName === "section");
  const summary = card.querySelector(".skills-summary");
  const panel = card.querySelector(".skills-panel");
  const reveal = card.querySelector(".skills-reveal");
  const lights = card.querySelector(".skill-lights");

  window.__tokenMeter.configure({ collapsible: true });
  assert.equal(card.classList.contains("expanded"), false);
  window.__tokenMeter.update({
    status: "bound",
    binding: { exact: true },
    sessionId: "session-skills",
    session: { totalTokens: 10, lastHourTokens: 10 },
    turn: { tokens: 10 },
    context: { tokens: 10, windowTokens: 100, percent: 10, compactionCount: 0 },
    account: { lastHourTokens: 10 },
    rate: { tokensPerMinute: 1, intensity: 0, band: "green" },
    anomaly: { level: "learning", baseline: { medianTokensPerMinute: 0 } },
    skills: {
      status: "loaded",
      items: [
        { name: "openai-docs", status: "loaded" },
        { name: "visualize", status: "not-loaded" },
      ],
    },
  });

  assert.equal(summary.textContent, "1 loaded · 1 not loaded");
  assert.equal(lights.children.length, 2);
  assert.equal(lights.children[0].dataset.status, "loaded");
  assert.equal(lights.children[0].title, "openai-docs");
  assert.equal(lights.children[1].dataset.status, "not-loaded");
  assert.match(lights.children[0].markup, /skill-logo/);
  assert.match(lights.children[0].markup, /title="openai-docs"/);
  assert.match(lights.children[0].markup, /tabindex="0"/);
  assert.doesNotMatch(lights.children[0].markup, /skill-gauge/);
  assert.match(lights.children[0].markup, /skill-name/);
  assert.equal(panel.classList.contains("labels-visible"), false);
  assert.equal(reveal.attributes.get("aria-expanded"), "false");
  reveal.click();
  assert.equal(panel.classList.contains("labels-visible"), true);
  assert.equal(reveal.attributes.get("aria-expanded"), "true");
  window.__tokenMeter.update({
    status: "bound",
    binding: { exact: true },
    sessionId: "next-session",
    session: { totalTokens: 20, lastHourTokens: 20 },
    turn: { tokens: 20 },
    context: { tokens: 20, windowTokens: 100, percent: 20, compactionCount: 0 },
    account: { lastHourTokens: 20 },
    rate: { tokensPerMinute: 1, intensity: 0, band: "green" },
    anomaly: { level: "learning", baseline: { medianTokensPerMinute: 0 } },
    skills: {
      status: "loaded",
      items: [{ name: "openai-docs", status: "loaded" }],
    },
  });
  assert.equal(panel.classList.contains("labels-visible"), false);
  assert.equal(reveal.attributes.get("aria-expanded"), "false");
  reveal.click();
  assert.equal(panel.classList.contains("labels-visible"), true);
});
