import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackWebSocketUrl } from "../integrations/codex-desktop/src/cdp-client.mjs";

test("CDP client accepts loopback targets only", () => {
  assert.equal(isLoopbackWebSocketUrl("ws://127.0.0.1:9334/devtools/page/1"), true);
  assert.equal(isLoopbackWebSocketUrl("ws://localhost:9334/devtools/page/1"), true);
  assert.equal(isLoopbackWebSocketUrl("ws://192.168.1.4:9334/devtools/page/1"), false);
  assert.equal(isLoopbackWebSocketUrl("wss://example.com/devtools/page/1"), false);
});
