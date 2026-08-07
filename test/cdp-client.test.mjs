import assert from "node:assert/strict";
import test from "node:test";
import {
  CdpClient,
  isLoopbackWebSocketUrl,
} from "../src/codex/cdp-client.mjs";

class FakeSocket extends EventTarget {
  constructor() {
    super();
    this.readyState = 1; // WebSocket.OPEN
    this.sent = [];
  }

  send(data) {
    this.sent.push(String(data));
  }

  close() {
    this.readyState = 3; // WebSocket.CLOSED
    this.dispatchEvent(new Event("close"));
  }

  receive(raw) {
    this.dispatchEvent(new MessageEvent("message", { data: raw }));
  }
}

test("CDP client accepts loopback targets only", () => {
  assert.equal(isLoopbackWebSocketUrl("ws://127.0.0.1:9334/devtools/page/1"), true);
  assert.equal(isLoopbackWebSocketUrl("ws://localhost:9334/devtools/page/1"), true);
  assert.equal(isLoopbackWebSocketUrl("ws://192.168.1.4:9334/devtools/page/1"), false);
  assert.equal(isLoopbackWebSocketUrl("wss://example.com/devtools/page/1"), false);
});

test("CDP client rejects a pending call when the socket closes", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  const call = client.call("Runtime.evaluate", { expression: "1" });
  socket.close();
  await assert.rejects(call, /CDP target closed/);
});

test("CDP client refuses calls on a closed socket", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  socket.close();
  await assert.rejects(
    client.call("Runtime.evaluate", { expression: "1" }),
    /not open/,
  );
});

test("CDP client resolves calls from matching responses", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  const call = client.call("Runtime.evaluate", { expression: "1" });
  const sent = JSON.parse(socket.sent[0]);
  assert.equal(sent.method, "Runtime.evaluate");
  socket.receive(
    JSON.stringify({ id: sent.id, result: { result: { value: 42 } } }),
  );
  assert.equal((await call).result.value, 42);
});

test("CDP client times out hung calls instead of hanging forever", async () => {
  const socket = new FakeSocket();
  const client = new CdpClient(socket);
  await assert.rejects(
    client.call("Runtime.evaluate", { expression: "1" }, { timeoutMs: 50 }),
    /timed out/,
  );
});
