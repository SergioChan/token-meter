import assert from "node:assert/strict";
import test from "node:test";
import {
  buildClaudeSessionProbeExpression,
  isClaudeDesktopSessionId,
} from "../src/claude/session-probe.mjs";

const sessionId = "local_11111111-2222-4333-8444-555555555555";

function runProbe({
  pathname = `/code/${sessionId}`,
  hash = "",
  activeHref = `/code/${sessionId}`,
  protocol = "file:",
  hostname = "",
  titleMarker = true,
  composer = true,
} = {}) {
  const document = {
    querySelectorAll(selector) {
      if (!selector.includes("aria-current") || activeHref == null) return [];
      return [
        {
          getAttribute(name) {
            return name === "href" ? activeHref : null;
          },
        },
      ];
    },
    querySelector(selector) {
      if (selector.includes("#root")) return {};
      if (selector.includes("session-title-split")) {
        return titleMarker ? {} : null;
      }
      if (selector.startsWith("textarea")) return composer ? {} : null;
      return null;
    },
  };
  const location = {
    href: `${protocol}//${hostname}${pathname}${hash}`,
    pathname,
    hash,
    protocol,
    hostname,
  };
  const window = { innerWidth: 1200, innerHeight: 800 };
  return Function(
    "document",
    "location",
    "window",
    `return ${buildClaudeSessionProbeExpression()}`,
  )(document, location, window);
}

test("Claude probe binds the exact active Code Session", () => {
  const result = runProbe();
  assert.equal(result.eligible, true);
  assert.equal(result.desktopSessionId, sessionId);
  assert.equal(result.bindingSource, "active-code-session-link");
  assert.equal(result.surface, "code");
});

test("Claude probe uses the exact Code route when no active link is exposed", () => {
  const result = runProbe({ activeHref: null });
  assert.equal(result.eligible, true);
  assert.equal(result.desktopSessionId, sessionId);
  assert.equal(result.bindingSource, "code-session-route");
});

test("Claude probe fails closed when route and active Session disagree", () => {
  const result = runProbe({
    activeHref: "/code/local_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
  assert.equal(result.eligible, false);
  assert.equal(result.desktopSessionId, null);
  assert.equal(result.bindingConflict, true);
});

test("Claude probe rejects auxiliary and incomplete renderer surfaces", () => {
  assert.equal(runProbe({ pathname: "/settings", activeHref: null }).eligible, false);
  assert.equal(runProbe({ titleMarker: false }).eligible, false);
  assert.equal(
    runProbe({ protocol: "https:", hostname: "example.com" }).eligible,
    false,
  );
});

test("Claude Desktop identity accepts only local UUIDs", () => {
  assert.equal(isClaudeDesktopSessionId(sessionId), true);
  assert.equal(isClaudeDesktopSessionId("session_11111111-2222-4333-8444-555555555555"), false);
  assert.equal(isClaudeDesktopSessionId("My Session"), false);
});
