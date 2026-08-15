import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeCloudSessionStore,
  claudeCloudEventsUrl,
  simpleCacheFileName,
} from "../integrations/claude-desktop/src/cloud-session-store.mjs";

const sessionId = "session_01HWYa9x7ncCBzndDSGPH4VM";

function user(sequence, timestamp) {
  return {
    sequence_num: String(sequence),
    created_at: new Date(timestamp).toISOString(),
    payload: {
      type: "user",
      timestamp,
      message: { role: "user", content: "discarded private prompt" },
    },
  };
}

function assistant(sequence, timestamp, id, usage) {
  return {
    sequence_num: String(sequence),
    created_at: new Date(timestamp).toISOString(),
    payload: {
      type: "assistant",
      timestamp,
      message: {
        id,
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "discarded private response" }],
        usage,
      },
    },
  };
}

test("Claude cloud cache identity maps to deterministic Simple Cache files", () => {
  assert.equal(
    simpleCacheFileName(claudeCloudEventsUrl(sessionId)),
    "23bbe4a5d12ba215_0",
  );
  assert.equal(
    simpleCacheFileName(claudeCloudEventsUrl(sessionId, "113")),
    "1437af16116a2ace_0",
  );
});

test("Claude cloud Session store follows a complete cached event chain", async () => {
  const responses = new Map([
    [
      claudeCloudEventsUrl(sessionId),
      {
        data: [
          assistant(4, 4_000, "response-2", {
            input_tokens: 1,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
            output_tokens: 4,
          }),
          user(3, 3_000),
        ],
        next_cursor: "3",
      },
    ],
    [
      claudeCloudEventsUrl(sessionId, "3"),
      {
        data: [
          assistant(2, 2_000, "response-1", {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 40,
          }),
          user(1, 1_000),
        ],
        next_cursor: null,
      },
    ],
  ]);
  const store = new ClaudeCloudSessionStore({
    responseReader: async (url) => responses.get(url) ?? null,
    refreshIntervalMs: 0,
    now: () => 5_000,
  });

  const result = await store.refresh(sessionId);
  assert.equal(result.status, "resolved");
  assert.equal(result.eventCount, 4);
  assert.equal(result.files.length, 1);
  const file = result.files[0];
  assert.equal(file.meta.id, sessionId);
  assert.equal(file.meta.threadSource, "user");
  assert.equal(file.usage.at(-1).total.totalTokens, 110);
  assert.equal(file.usage.at(-1).contextTokens, 6);
  assert.deepEqual(file.userMessages, [1_000, 3_000]);
  assert.deepEqual(file.turnCompletions, [2_000, 4_000]);
  assert.equal(JSON.stringify(file).includes("discarded private"), false);
});

test("Claude cloud Session store fails closed on a partial cache", async () => {
  const store = new ClaudeCloudSessionStore({
    responseReader: async () => ({
      data: [user(2, 2_000)],
      next_cursor: null,
    }),
    refreshIntervalMs: 0,
  });
  const result = await store.refresh(sessionId);
  assert.equal(result.status, "unbound");
  assert.equal(result.reason, "cloud-session-cache-incomplete");
});
