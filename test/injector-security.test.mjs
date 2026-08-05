import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLsofListenerRecords,
  verifyCodexListenerRecords,
} from "../src/codex/injector.mjs";

const codexCommand =
  "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9334";

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
