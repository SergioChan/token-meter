import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractSkillNames,
  parseRolloutLine,
  RolloutStore,
} from "../src/core/rollout-store.mjs";

test("skill inventory parser keeps names only and de-duplicates entries", () => {
  assert.deepEqual(
    extractSkillNames(`
### Available skills
- browser:control-in-app-browser: Control the in-app Browser.
- browser:control-in-app-browser: duplicate
- visualize:visualize: Create visualizations.

## Other instructions
- not-a-skill: ignored
`),
    ["browser:control-in-app-browser", "visualize:visualize"],
  );
  assert.deepEqual(
    extractSkillNames(`### Available skills
- imagegen: Generate raster images: safely.
- figma:figma-use: Use Figma: with a required prerequisite.
`),
    ["imagegen", "figma:figma-use"],
  );
});

test("rollout parser records a Session skill inventory without retaining instructions", () => {
  const parsed = parseRolloutLine(
    JSON.stringify({
      timestamp: "2026-08-05T00:00:00.000Z",
      type: "world_state",
      payload: {
        state: {
          host_skills: {
            body: `### Available skills
- openai-docs: Official docs
`,
          },
        },
      },
    }),
  );
  assert.deepEqual(parsed, {
    kind: "skillInventory",
    timestampMs: Date.parse("2026-08-05T00:00:00.000Z"),
    skills: ["openai-docs"],
  });
  assert.equal(JSON.stringify(parsed).includes("Official docs"), false);
});

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

test("rollout parser records context compaction without retaining content", () => {
  const parsed = parseRolloutLine(
    JSON.stringify({
      timestamp: "2026-08-05T00:00:00.000Z",
      type: "event_msg",
      payload: { type: "context_compacted" },
    }),
  );
  assert.deepEqual(parsed, {
    kind: "contextCompacted",
    timestampMs: Date.parse("2026-08-05T00:00:00.000Z"),
  });
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

test("an exact active thread bypasses throttled file discovery", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-discovery-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const id = "00000000-0000-0000-0000-000000000002";
  const store = new RolloutStore({
    sessionsDirectory: directory,
    discoveryIntervalMs: 60_000,
  });
  assert.deepEqual(await store.refresh(), []);

  const filePath = path.join(
    directory,
    `rollout-2026-08-05T00-00-00-${id}.jsonl`,
  );
  await writeFile(
    filePath,
    `${JSON.stringify({
      timestamp: "2026-08-05T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id,
        session_id: id,
        source: "vscode",
        thread_source: "user",
      },
    })}\n`,
  );

  const files = await store.refresh({ activeThreadIds: [id] });
  assert.equal(files[0].meta.id, id);
});

test("an active session includes child rollouts created on another date", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-session-tree-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const rootId = "00000000-0000-0000-0000-000000000010";
  const childId = "00000000-0000-0000-0000-000000000011";
  const rootDirectory = path.join(directory, "2026", "08", "04");
  const childDirectory = path.join(directory, "2026", "08", "05");
  await Promise.all([
    mkdir(rootDirectory, { recursive: true }),
    mkdir(childDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(rootDirectory, `rollout-root-${rootId}.jsonl`),
      `${JSON.stringify({
        timestamp: "2026-08-04T23:59:00.000Z",
        type: "session_meta",
        payload: {
          id: rootId,
          session_id: rootId,
          source: "vscode",
          thread_source: "user",
        },
      })}\n`,
    ),
    writeFile(
      path.join(childDirectory, `rollout-child-${childId}.jsonl`),
      `${JSON.stringify({
        timestamp: "2026-08-05T00:01:00.000Z",
        type: "session_meta",
        payload: {
          id: childId,
          session_id: rootId,
          source: { subagent: {} },
          thread_source: "subagent",
        },
      })}\n`,
    ),
  ]);

  const store = new RolloutStore({
    sessionsDirectory: directory,
    historyFileLimit: 0,
  });
  const files = await store.refresh({ activeThreadIds: [rootId] });

  assert.deepEqual(
    files.map((file) => file.discoveredId).sort(),
    [rootId, childId],
  );
});

test("a deleted rollout is removed from the live index without stopping refresh", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-deleted-rollout-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const id = "00000000-0000-0000-0000-000000000020";
  const filePath = path.join(directory, `rollout-deleted-${id}.jsonl`);
  await writeFile(
    filePath,
    `${JSON.stringify({
      timestamp: "2026-08-05T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id,
        session_id: id,
        source: "vscode",
        thread_source: "user",
      },
    })}\n`,
  );
  const store = new RolloutStore({ sessionsDirectory: directory });
  assert.equal((await store.refresh({ activeThreadIds: [id] })).length, 1);

  await rm(filePath);
  await store.discover({ force: true });

  assert.deepEqual(await store.refresh({ activeThreadIds: [id] }), []);
});

test("a filesystem notification makes a new child Agent discoverable immediately", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-dirty-index-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const rootId = "00000000-0000-0000-0000-000000000030";
  const childId = "00000000-0000-0000-0000-000000000031";
  const rootPath = path.join(directory, `rollout-root-${rootId}.jsonl`);
  await writeFile(
    rootPath,
    `${JSON.stringify({
      timestamp: "2026-08-05T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: rootId,
        session_id: rootId,
        source: "vscode",
        thread_source: "user",
      },
    })}\n`,
  );
  const store = new RolloutStore({
    sessionsDirectory: directory,
    historyFileLimit: 0,
    discoveryIntervalMs: 60_000,
  });
  await store.refresh({ activeThreadIds: [rootId] });
  await writeFile(
    path.join(directory, `rollout-child-${childId}.jsonl`),
    `${JSON.stringify({
      timestamp: "2026-08-05T00:00:01.000Z",
      type: "session_meta",
      payload: {
        id: childId,
        session_id: rootId,
        source: { subagent: {} },
        thread_source: "subagent",
      },
    })}\n`,
  );

  store.markDiscoveryDirty();
  const files = await store.refresh({ activeThreadIds: [rootId] });

  assert.deepEqual(
    files.map((file) => file.discoveredId).sort(),
    [rootId, childId],
  );
});
