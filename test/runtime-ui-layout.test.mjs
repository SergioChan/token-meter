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
    this.style = { setProperty() {} };
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
