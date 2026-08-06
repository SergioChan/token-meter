import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionProbeExpression,
  isThreadId,
} from "../integrations/codex-desktop/src/session-probe.mjs";

const threadId = "11111111-2222-4333-8444-555555555555";

function runProbe({
  activeId = threadId,
  conversationIds = [],
  pathname = `/thread/${threadId}`,
} = {}) {
  const mainSurface = {};
  const activeRow = {
    getAttribute(name) {
      return name === "data-app-action-sidebar-thread-id" ? activeId : null;
    },
  };
  const conversationNodes = conversationIds.map((conversationId) => ({
    getAttribute(name) {
      return name === "data-above-composer-conversation-id"
        ? conversationId
        : null;
    },
  }));
  const document = {
    querySelector(selector) {
      if (selector.includes("avatar-overlay")) return null;
      if (selector.includes("sidebar-thread-active")) return activeId ? activeRow : null;
      if (selector === "aside.app-shell-left-panel") return {};
      if (selector.includes("main[data-app-shell-main-surface]")) return mainSurface;
      if (selector.startsWith("textarea")) return {};
      return null;
    },
    querySelectorAll(selector) {
      return selector === "[data-above-composer-conversation-id]"
        ? conversationNodes
        : [];
    },
  };
  const location = {
    href: `app://-/index.html${pathname}`,
    pathname,
    protocol: "app:",
  };
  const window = { innerWidth: 1200, innerHeight: 800 };
  return Function(
    "document",
    "location",
    "window",
    `return ${buildSessionProbeExpression()}`,
  )(document, location, window);
}

test("session probe binds to the exact active sidebar thread", () => {
  const result = runProbe();
  assert.equal(result.eligible, true);
  assert.equal(result.threadId, threadId);
  assert.equal(result.bindingSource, "active-sidebar-row");
});

test("session probe normalizes Codex local thread identifiers", () => {
  const result = runProbe({
    activeId: `local:${threadId}`,
    pathname: "/index.html",
  });
  assert.equal(result.eligible, true);
  assert.equal(result.threadId, threadId);
  assert.equal(result.bindingSource, "active-sidebar-row");
});

test("session probe resolves a client-new-thread row from the active conversation", () => {
  const result = runProbe({
    activeId: "local:client-new-thread:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    conversationIds: [threadId],
    pathname: "/index.html",
  });
  assert.equal(result.eligible, true);
  assert.equal(result.threadId, threadId);
  assert.equal(result.bindingSource, "active-conversation-surface");
});

test("session probe rejects ambiguous active conversation identifiers", () => {
  const result = runProbe({
    activeId: "local:client-new-thread:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    conversationIds: [
      threadId,
      "66666666-7777-4888-8999-aaaaaaaaaaaa",
    ],
    pathname: "/index.html",
  });
  assert.equal(result.eligible, true);
  assert.equal(result.threadId, null);
  assert.equal(result.bindingSource, null);
});

test("session probe falls back to the exact route and rejects ambiguous labels", () => {
  const result = runProbe({ activeId: "not-a-thread-id" });
  assert.equal(result.threadId, threadId);
  assert.equal(result.bindingSource, "thread-route");
  assert.equal(isThreadId("My project name"), false);
});
