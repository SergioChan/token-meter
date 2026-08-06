import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ClaudeTranscriptStore,
  encodeClaudeProjectDirectory,
  normalizeClaudeUsage,
  parseClaudeTranscriptLine,
} from "../integrations/claude-desktop/src/transcript-store.mjs";
import { MetricsEngine } from "../src/core/metrics-engine.mjs";

const desktopSessionId = "local_00000000-0000-4000-8000-000000000011";
const cliSessionId = "00000000-0000-4000-8000-000000000012";
const cwd = "/private/My Repository";

function resolvedSession(overrides = {}) {
  return {
    status: "resolved",
    desktopSessionId,
    cliSessionId,
    cwd,
    createdAtMs: 0,
    ...overrides,
  };
}

function user(timestamp, content = "private prompt", overrides = {}) {
  return {
    type: "user",
    timestamp,
    message: { role: "user", content },
    ...overrides,
  };
}

function assistant(
  timestamp,
  id,
  usage,
  { stopReason = "tool_use", ...overrides } = {},
) {
  return {
    type: "assistant",
    timestamp,
    requestId: `request-${id}`,
    message: {
      id,
      role: "assistant",
      stop_reason: stopReason,
      usage,
      content: [{ type: "text", text: "private assistant content" }],
    },
    ...overrides,
  };
}

function jsonl(values) {
  return `${values.map(JSON.stringify).join("\n")}\n`;
}

async function fixture(context) {
  const projectsDirectory = await mkdtemp(
    path.join(os.tmpdir(), "token-meter-claude-projects-"),
  );
  context.after(() => rm(projectsDirectory, { recursive: true, force: true }));
  const projectDirectory = path.join(
    projectsDirectory,
    encodeClaudeProjectDirectory(cwd),
  );
  const rootPath = path.join(projectDirectory, `${cliSessionId}.jsonl`);
  const childDirectory = path.join(
    projectDirectory,
    cliSessionId,
    "subagents",
    "workflows",
    "workflow-1",
  );
  await mkdir(childDirectory, { recursive: true });
  return {
    projectsDirectory,
    rootPath,
    childPath: path.join(childDirectory, "agent-1.jsonl"),
    journalPath: path.join(childDirectory, "journal.jsonl"),
  };
}

test("Claude usage includes uncached, cache-write, cache-read, and output tokens once", () => {
  assert.deepEqual(
    normalizeClaudeUsage({
      input_tokens: 2,
      cache_creation_input_tokens: 3,
      cache_read_input_tokens: 5,
      output_tokens: 7,
      output_tokens_details: { thinking_tokens: 4 },
    }),
    {
      totalTokens: 17,
      inputTokens: 10,
      cachedInputTokens: 5,
      cacheCreationInputTokens: 3,
      outputTokens: 7,
      reasoningOutputTokens: 4,
    },
  );
});

test("Claude transcript parser discards content and separates turn boundaries", () => {
  const parsedUser = parseClaudeTranscriptLine(
    JSON.stringify(user(1, "private prompt")),
  );
  assert.deepEqual(parsedUser, { kind: "userMessage", timestampMs: 1 });
  assert.equal(JSON.stringify(parsedUser).includes("private prompt"), false);

  const toolResult = parseClaudeTranscriptLine(
    JSON.stringify(
      user(2, [{ type: "tool_result", content: "private tool output" }], {
        sourceToolAssistantUUID: "assistant-uuid",
      }),
    ),
  );
  assert.equal(toolResult, null);

  const compacted = parseClaudeTranscriptLine(
    JSON.stringify(user(3, "private summary", { isCompactSummary: true })),
  );
  assert.deepEqual(compacted, { kind: "contextCompacted", timestampMs: 3 });

  const zeroUsageError = parseClaudeTranscriptLine(
    JSON.stringify(
      assistant(
        4,
        "msg-error",
        { input_tokens: 0, output_tokens: 0 },
        { stopReason: "stop_sequence", isApiErrorMessage: true },
      ),
    ),
  );
  assert.deepEqual(zeroUsageError, {
    kind: "assistantTerminal",
    responseId: "msg-error",
    timestampMs: 4,
    terminal: "aborted",
  });
});

test("collector de-duplicates repeated rows and replaces a partial usage snapshot", async (context) => {
  const paths = await fixture(context);
  await writeFile(
    paths.rootPath,
    jsonl([
      user(0),
      assistant(1, "msg-root-1", { input_tokens: 10, output_tokens: 2 }, { stopReason: null }),
      assistant(2, "msg-root-1", { input_tokens: 10, output_tokens: 2 }, { stopReason: null }),
      assistant(3, "msg-root-1", { input_tokens: 10, output_tokens: 4 }, { stopReason: "end_turn" }),
      user(10, [{ type: "text", text: "second private prompt" }]),
      assistant(11, "msg-root-2", {
        input_tokens: 1,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        output_tokens: 4,
      }),
      assistant(12, "msg-root-3", { input_tokens: 2, output_tokens: 3 }, { stopReason: "end_turn" }),
      user(13, "private compacted context", {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
    ]),
  );
  await Promise.all([
    writeFile(
      paths.childPath,
      jsonl([
        assistant(11.5, "msg-child-1", { input_tokens: 20, output_tokens: 5 }, { stopReason: null }),
        assistant(11.6, "msg-child-1", { input_tokens: 20, output_tokens: 8 }),
        assistant(11.7, "msg-root-3", { input_tokens: 999_999, output_tokens: 1 }),
      ]),
    ),
    writeFile(
      paths.journalPath,
      jsonl([
        assistant(11.8, "msg-journal", { input_tokens: 999_999, output_tokens: 1 }),
      ]),
    ),
  ]);

  const store = new ClaudeTranscriptStore({
    projectsDirectory: paths.projectsDirectory,
    readChunkBytes: 31,
  });
  const files = await store.refresh({ session: resolvedSession() });
  const root = files.find((file) => file.meta.threadSource === "user");
  const child = files.find((file) => file.meta.threadSource === "subagent");
  assert.equal(files.length, 2);
  assert.equal(root.usage.at(-1).total.totalTokens, 29);
  assert.equal(child.usage.at(-1).total.totalTokens, 28);
  assert.deepEqual(root.userMessages, [0, 10]);
  assert.deepEqual(root.turnCompletions, [3, 12]);
  assert.deepEqual(root.contextCompactions, [13]);
  const serialized = JSON.stringify(files);
  assert.equal(serialized.includes("private prompt"), false);
  assert.equal(serialized.includes("private assistant content"), false);
  assert.equal(serialized.includes("private compacted context"), false);

  const snapshot = new MetricsEngine().snapshot(files, {
    threadId: desktopSessionId,
    nowMs: 20,
    hostName: "Claude Desktop",
  });
  assert.equal(snapshot.status, "bound");
  assert.equal(snapshot.session.totalTokens, 57);
  assert.equal(snapshot.turn.tokens, 43);
  assert.equal(snapshot.childAgentCount, 1);
  assert.equal(snapshot.context.tokens, null);
});

test("collector consumes appended rows incrementally and resets after truncation", async (context) => {
  const paths = await fixture(context);
  await writeFile(
    paths.rootPath,
    jsonl([
      user(0),
      assistant(1, "msg-1", { input_tokens: 10, output_tokens: 2 }, { stopReason: null }),
    ]),
  );
  const store = new ClaudeTranscriptStore({
    projectsDirectory: paths.projectsDirectory,
    discoveryIntervalMs: 60_000,
  });
  let files = await store.refresh({ session: resolvedSession() });
  assert.equal(files[0].usage.at(-1).total.totalTokens, 12);

  const finalRow = JSON.stringify(
    assistant(2, "msg-1", { input_tokens: 10, output_tokens: 5 }, { stopReason: "end_turn" }),
  );
  await appendFile(paths.rootPath, finalRow.slice(0, 20));
  files = await store.refresh({ session: resolvedSession() });
  assert.equal(files[0].usage.at(-1).total.totalTokens, 12);
  await appendFile(paths.rootPath, `${finalRow.slice(20)}\n`);
  files = await store.refresh({ session: resolvedSession() });
  assert.equal(files[0].usage.at(-1).total.totalTokens, 15);
  assert.deepEqual(files[0].turnCompletions, [2]);

  await writeFile(
    paths.rootPath,
    jsonl([
      user(10),
      assistant(11, "msg-2", { input_tokens: 3, output_tokens: 4 }, { stopReason: "end_turn" }),
    ]),
  );
  files = await store.refresh({ session: resolvedSession() });
  assert.equal(files[0].usage.at(-1).total.totalTokens, 7);
  assert.deepEqual(files[0].userMessages, [10]);
});

test("collector exposes the latest root input usage as active context", async (context) => {
  const paths = await fixture(context);
  await writeFile(
    paths.rootPath,
    jsonl([
      user(0),
      assistant(
        1,
        "msg-context-1",
        {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 40,
        },
        { stopReason: "end_turn" },
      ),
      user(2),
      assistant(
        3,
        "msg-context-2",
        {
          input_tokens: 100,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 300,
          output_tokens: 400,
        },
        { stopReason: "end_turn" },
      ),
    ]),
  );

  const store = new ClaudeTranscriptStore({
    projectsDirectory: paths.projectsDirectory,
  });
  const files = await store.refresh({ session: resolvedSession() });
  const snapshot = new MetricsEngine().snapshot(files, {
    threadId: desktopSessionId,
    nowMs: 4,
    hostName: "Claude Desktop",
  });

  assert.equal(snapshot.session.totalTokens, 1_100);
  assert.equal(snapshot.context.tokens, 600);
  assert.equal(snapshot.context.windowTokens, null);
  assert.equal(snapshot.context.percent, null);

  await appendFile(
    paths.rootPath,
    jsonl([
      user(5, "private compacted context", {
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
      }),
    ]),
  );
  let refreshed = await store.refresh({ session: resolvedSession() });
  let refreshedSnapshot = new MetricsEngine().snapshot(refreshed, {
    threadId: desktopSessionId,
    nowMs: 6,
    hostName: "Claude Desktop",
  });
  assert.equal(refreshedSnapshot.session.totalTokens, 1_100);
  assert.equal(refreshedSnapshot.context.tokens, null);

  await appendFile(
    paths.rootPath,
    jsonl([
      assistant(
        7,
        "msg-context-3",
        {
          input_tokens: 100,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 400,
          output_tokens: 500,
        },
        { stopReason: "end_turn" },
      ),
    ]),
  );
  refreshed = await store.refresh({ session: resolvedSession() });
  refreshedSnapshot = new MetricsEngine().snapshot(refreshed, {
    threadId: desktopSessionId,
    nowMs: 8,
    hostName: "Claude Desktop",
  });
  assert.equal(refreshedSnapshot.session.totalTokens, 2_300);
  assert.equal(refreshedSnapshot.context.tokens, 700);
});

test("collector reads through bounded chunks and skips oversized transcript rows", async (context) => {
  const paths = await fixture(context);
  await writeFile(
    paths.rootPath,
    jsonl([
      user(0),
      assistant(1, "msg-too-large", { input_tokens: 999, output_tokens: 1 }, {
        contentPadding: "x".repeat(2_000),
      }),
      assistant(2, "msg-kept", { input_tokens: 3, output_tokens: 4 }, { stopReason: "end_turn" }),
    ]),
  );
  const readLengths = [];
  const store = new ClaudeTranscriptStore({
    projectsDirectory: paths.projectsDirectory,
    readChunkBytes: 64,
    maxLineBytes: 512,
    readRange: async (filePath, { length, position }) => {
      readLengths.push(length);
      assert.ok(length <= 64);
      const handle = await open(filePath, "r");
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  });
  const files = await store.refresh({ session: resolvedSession() });
  assert.ok(readLengths.length > 1);
  assert.equal(files[0].usage.at(-1).total.totalTokens, 7);
  assert.equal(files[0].diagnostics.skippedOversizedLineCount, 1);
});

test("collector clears the previous Session when the exact binding changes", async (context) => {
  const paths = await fixture(context);
  await writeFile(
    paths.rootPath,
    jsonl([assistant(1, "msg-old", { input_tokens: 10, output_tokens: 1 })]),
  );
  const store = new ClaudeTranscriptStore({
    projectsDirectory: paths.projectsDirectory,
  });
  let files = await store.refresh({ session: resolvedSession() });
  assert.equal(files[0].usage.at(-1).total.totalTokens, 11);

  const nextSession = resolvedSession({
    desktopSessionId: "local_00000000-0000-4000-8000-000000000021",
    cliSessionId: "00000000-0000-4000-8000-000000000022",
  });
  const nextRootPath = path.join(
    path.dirname(paths.rootPath),
    `${nextSession.cliSessionId}.jsonl`,
  );
  await writeFile(
    nextRootPath,
    jsonl([assistant(2, "msg-new", { input_tokens: 2, output_tokens: 3 })]),
  );
  files = await store.refresh({ session: nextSession });
  assert.equal(files[0].meta.id, nextSession.desktopSessionId);
  assert.equal(files[0].usage.at(-1).total.totalTokens, 5);
});
