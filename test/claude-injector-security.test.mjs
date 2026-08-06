import assert from "node:assert/strict";
import test from "node:test";
import {
  attachClaudeTarget,
  isPotentialClaudePageTarget,
  parseClaudeLsofListenerRecords,
  verifyClaudeListenerRecords,
} from "../integrations/claude-desktop/src/injector.mjs";

const claudeExecutable = "/Applications/Claude.app/Contents/MacOS/Claude";

test("an ineligible Claude renderer never receives persistent injection", async () => {
  const calls = [];
  const client = {
    async call(method) {
      calls.push(method);
    },
    async evaluate() {
      return { eligible: false };
    },
    close() {},
  };
  const result = await attachClaudeTarget(
    {
      id: "settings",
      webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/page/1",
    },
    "window.__tokenMeter = true",
    { connect: async () => client },
  );
  assert.equal(result, null);
  assert.equal(calls.includes("Page.addScriptToEvaluateOnNewDocument"), false);
});

test("Claude target filter accepts only loopback pages on trusted app surfaces", () => {
  assert.equal(
    isPotentialClaudePageTarget({
      type: "page",
      url: "file:///Applications/Claude.app/Contents/Resources/ion-dist/index.html",
      webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/page/1",
    }),
    true,
  );
  assert.equal(
    isPotentialClaudePageTarget({
      type: "page",
      url: "https://example.com/code/local_11111111-2222-4333-8444-555555555555",
      webSocketDebuggerUrl: "ws://127.0.0.1:9335/devtools/page/2",
    }),
    false,
  );
  assert.equal(
    isPotentialClaudePageTarget({
      type: "page",
      url: "file:///Applications/Claude.app/index.html",
      webSocketDebuggerUrl: "ws://192.0.2.10:9335/devtools/page/3",
    }),
    false,
  );
});

test("Claude listener verification accepts one app socket inherited by a child", () => {
  const records = parseClaudeLsofListenerRecords(
    [
      "p100",
      "R1",
      "d0x-shared",
      "p101",
      "R100",
      "d0x-shared",
      "",
    ].join("\n"),
  );
  assert.equal(
    verifyClaudeListenerRecords(
      records,
      new Map([
        ["100", `${claudeExecutable} --remote-debugging-port=9335`],
        ["101", "/Applications/Claude.app/Contents/Frameworks/Claude Helper"],
      ]),
      { executablePath: claudeExecutable },
    ),
    "100",
  );
});

test("Claude listener verification rejects unrelated and lookalike owners", () => {
  const records = parseClaudeLsofListenerRecords(
    ["p100", "R1", "d0x-shared", ""].join("\n"),
  );
  assert.throws(
    () =>
      verifyClaudeListenerRecords(
        records,
        new Map([["100", "/tmp/Claude.app/Contents/MacOS/Claude"]]),
        { executablePath: claudeExecutable },
      ),
    /not owned by the expected Claude application/,
  );
});
