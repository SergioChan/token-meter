import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseRolloutLine,
  RolloutStore,
} from "../src/core/rollout-store.mjs";

test("rollout parser extracts usage without retaining message content", () => {
  const parsed = parseRolloutLine(
    JSON.stringify({
      timestamp: "2026-08-05T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 123,
            input_tokens: 100,
            cached_input_tokens: 80,
            output_tokens: 23,
            reasoning_output_tokens: 5,
          },
          last_token_usage: { total_tokens: 23 },
          model_context_window: 200000,
        },
      },
    }),
  );

  assert.deepEqual(parsed, {
    kind: "usage",
    timestampMs: Date.parse("2026-08-05T00:00:00.000Z"),
    total: {
      totalTokens: 123,
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 23,
      reasoningOutputTokens: 5,
    },
    last: {
      totalTokens: 23,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
    contextWindow: 200000,
  });
});

test("rollout parser ignores user message bodies", () => {
  const parsed = parseRolloutLine(
    JSON.stringify({
      timestamp: "2026-08-05T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "private prompt" },
    }),
  );
  assert.deepEqual(parsed, {
    kind: "userMessage",
    timestampMs: Date.parse("2026-08-05T00:00:00.000Z"),
  });
  assert.equal(JSON.stringify(parsed).includes("private prompt"), false);
});

test("rollout files are read through bounded chunks", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-rollout-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(
    directory,
    "rollout-2026-08-05T00-00-00-00000000-0000-0000-0000-000000000001.jsonl",
  );
  const lines = [
    {
      timestamp: "2026-08-05T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "00000000-0000-0000-0000-000000000001",
        session_id: "00000000-0000-0000-0000-000000000001",
        source: "vscode",
        thread_source: "user",
      },
    },
    {
      timestamp: "2026-08-05T00:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 42 } },
      },
    },
  ];
  await writeFile(filePath, `${lines.map(JSON.stringify).join("\n")}\n`);

  const readLengths = [];
  const store = new RolloutStore({
    sessionsDirectory: directory,
    readChunkBytes: 32,
    readRange: async (targetPath, { length, position }) => {
      readLengths.push(length);
      assert.ok(length <= 32, `read ${length} bytes in one operation`);
      const handle = await open(targetPath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  });

  const files = await store.refresh({ force: true });
  assert.ok(readLengths.length > 1);
  assert.equal(files[0].usage[0].total.totalTokens, 42);
});
