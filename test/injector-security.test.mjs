import assert from "node:assert/strict";
import test from "node:test";
import {
  attachCodexTarget,
  buildCodexMeterPayload,
  parseLsofListenerRecords,
  verifyCodexBundleIdentity,
  verifyCodexListenerRecords,
} from "../integrations/codex-desktop/src/injector.mjs";

const codexCommand =
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9334";

test("Codex payload enables persistent compact and draggable layout", () => {
  const payload = buildCodexMeterPayload(
    "window.__tokenMeter = {}; __TOKEN_METER_CSS_JSON__",
    ":host {}",
  );
  assert.match(payload, /collapsible:\s*true/);
  assert.match(payload, /draggable:\s*true/);
  assert.match(payload, /token-meter:codex-layout/);
});

test("an ineligible renderer never receives a persistent injection script", async () => {
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

  const result = await attachCodexTarget(
    { id: "auxiliary", webSocketDebuggerUrl: "ws://127.0.0.1:9334/devtools/page/1" },
    "window.__tokenMeter = true",
    { connect: async () => client },
  );

  assert.equal(result, null);
  assert.equal(calls.includes("Page.addScriptToEvaluateOnNewDocument"), false);
});

test("listener verification accepts one Codex socket inherited by a child", () => {
  const records = parseLsofListenerRecords(
    [
      "p73639",
      "R1",
      "f58",
      "d0x2a9c1c60cf15e718",
      "p73726",
      "R73639",
      "f58",
      "d0x2a9c1c60cf15e718",
      "",
    ].join("\n"),
  );

  assert.equal(
    verifyCodexListenerRecords(
      records,
      new Map([
        ["73639", codexCommand],
        ["73726", "/path/SkyComputerUseService"],
      ]),
    ),
    "73639",
  );
});

test("listener verification rejects multiple listening sockets", () => {
  const records = parseLsofListenerRecords(
    [
      "p73639",
      "R1",
      "f58",
      "d0x-first",
      "p73726",
      "R73639",
      "f59",
      "d0x-second",
      "",
    ].join("\n"),
  );

  assert.throws(
    () =>
      verifyCodexListenerRecords(
        records,
        new Map([
          ["73639", codexCommand],
          ["73726", "/path/SkyComputerUseService"],
        ]),
      ),
    /Expected one Codex CDP listening socket/,
  );
});

test("listener verification rejects an unrelated socket holder", () => {
  const records = parseLsofListenerRecords(
    [
      "p73639",
      "R1",
      "f58",
      "d0x-shared",
      "p90000",
      "R1",
      "f58",
      "d0x-shared",
      "",
    ].join("\n"),
  );

  assert.throws(
    () =>
      verifyCodexListenerRecords(
        records,
        new Map([
          ["73639", codexCommand],
          ["90000", "/tmp/unrelated"],
        ]),
      ),
    /not in the Codex process tree/,
  );
});

test("listener verification rejects a lookalike application outside the expected bundle", () => {
  const records = parseLsofListenerRecords(
    ["p73639", "R1", "f58", "d0x-shared", ""].join("\n"),
  );

  assert.throws(
    () =>
      verifyCodexListenerRecords(
        records,
        new Map([
          [
            "73639",
            "/tmp/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9334",
          ],
        ]),
      ),
    /not owned by the expected Codex application/,
  );
});

test("bundle verification accepts only the signed OpenAI Codex identity", () => {
  assert.doesNotThrow(() =>
    verifyCodexBundleIdentity({
      bundleId: "com.openai.codex",
      teamId: "2DC432GLL2",
    }),
  );
  assert.throws(
    () =>
      verifyCodexBundleIdentity({
        bundleId: "com.openai.codex",
        teamId: "ATTACKER01",
      }),
    /unexpected signing identity/,
  );
});
