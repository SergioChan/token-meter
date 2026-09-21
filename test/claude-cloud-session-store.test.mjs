import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import {
  ClaudeCloudSessionStore,
  claudeCloudEventsUrl,
  claudeCloudEventsUrlFor,
  simpleCacheFileName,
} from "../integrations/claude-desktop/src/cloud-session-store.mjs";
import { buildSimpleCacheEntry, writeSimpleCacheEntry } from "./fixtures/simple-cache-entry.mjs";

const core = "01HWYa9x7ncCBzndDSGPH4VM";
const sessionId = `session_${core}`;
const cseId = `cse_${core}`;
const hasZstd = typeof zlib.zstdCompressSync === "function";

function iso(sequence) {
  return new Date(Date.UTC(2026, 8, 20, 0, 0, sequence)).toISOString();
}

function user(sequence, extra = {}) {
  return {
    sequence_num: String(sequence),
    created_at: iso(sequence),
    payload: { type: "user", message: { role: "user", content: "discarded private prompt" }, ...extra },
  };
}

function assistant(sequence, id, usage, extra = {}) {
  return {
    sequence_num: String(sequence),
    created_at: iso(sequence),
    payload: {
      type: "assistant",
      message: {
        id,
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "discarded private response" }],
        usage,
      },
      ...extra,
    },
  };
}

const smallUsage = { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 };

/** Alternate user/assistant rows for sequences `from..to` inclusive, newest first. */
function rows(from, to) {
  const list = [];
  for (let sequence = from; sequence >= to; sequence -= 1) {
    list.push(sequence % 2 === 0 ? assistant(sequence, `response-${sequence}`, smallUsage) : user(sequence));
  }
  return list;
}

function encode(value, format) {
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  if (format === "zstd") return zlib.zstdCompressSync(bytes);
  if (format === "gzip") return zlib.gzipSync(bytes);
  return bytes;
}

async function makeCacheDirectory(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-cloud-cache-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  // Unrelated entries that a real cache is full of.
  await writeSimpleCacheEntry(directory, "https://claude.ai/api/organizations/x/chat_conversations", Buffer.from("{}"));
  await writeSimpleCacheEntry(directory, "https://claude.ai/v1/code/sessions/session_02zzzzzzzzzzzzzzzzzzzzzz/events?limit=200&sort_order=desc", Buffer.from(JSON.stringify({ data: rows(4, 1) })));
  await writeFile(path.join(directory, "index"), "not an entry");
  return directory;
}

function makeStore(directory, overrides = {}) {
  return new ClaudeCloudSessionStore({
    cacheDirectory: directory,
    indexPersistPath: null,
    refreshIntervalMs: 0,
    ...overrides,
  });
}

test("Claude cloud cache identity maps to deterministic Simple Cache files", () => {
  assert.equal(simpleCacheFileName(claudeCloudEventsUrl(sessionId)), "23bbe4a5d12ba215_0");
  assert.equal(simpleCacheFileName(claudeCloudEventsUrl(sessionId, "113")), "1437af16116a2ace_0");
  assert.equal(
    claudeCloudEventsUrlFor(cseId, { limit: 500, sortOrder: null, cursor: 110 }),
    `https://claude.ai/v1/code/sessions/${cseId}/events?limit=500&cursor=110`,
  );
});

test("an injected legacy response reader still resolves a complete cursor chain", async () => {
  const responses = new Map([
    [claudeCloudEventsUrl(sessionId), { data: [assistant(4, "response-2", smallUsage), user(3)], next_cursor: "3" }],
    [claudeCloudEventsUrl(sessionId, "3"), { data: [assistant(2, "response-1", { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 }), user(1)], next_cursor: null }],
  ]);
  const store = new ClaudeCloudSessionStore({
    index: false,
    responseReader: async (url) => responses.get(url) ?? null,
    refreshIntervalMs: 0,
  });
  const result = await store.refresh(sessionId);
  assert.equal(result.status, "resolved");
  assert.equal(result.complete, true);
  assert.equal(result.eventCount, 4);
  const [file] = result.files;
  assert.equal(file.meta.id, sessionId);
  assert.equal(file.usage.at(-1).total.totalTokens, 110);
  assert.equal(file.usage.at(-1).contextTokens, 6);
  assert.deepEqual(file.userMessages, [Date.parse(iso(1)), Date.parse(iso(3))]);
  assert.deepEqual(file.turnCompletions, [Date.parse(iso(2)), Date.parse(iso(4))]);
  assert.equal(JSON.stringify(result).includes("discarded private"), false);
});

test("a partial cache binds as a lower bound by default and fails closed in strict mode", async () => {
  const reader = async (url) => (url === claudeCloudEventsUrl(sessionId) ? { data: [assistant(4, "response-2", smallUsage), user(3)], next_cursor: "3" } : null);
  const lenient = await new ClaudeCloudSessionStore({ index: false, responseReader: reader, refreshIntervalMs: 0 }).refresh(sessionId);
  assert.equal(lenient.status, "resolved");
  assert.equal(lenient.complete, false);
  assert.deepEqual(lenient.coverage, { knownSequences: 2, firstSequence: 3, lastSequence: 4, maxSequence: 4, missingSequences: 2 });
  assert.equal(lenient.files[0].diagnostics.complete, false);

  const strict = await new ClaudeCloudSessionStore({ index: false, responseReader: reader, refreshIntervalMs: 0, allowPartial: false }).refresh(sessionId);
  assert.equal(strict.status, "unbound");
  assert.equal(strict.reason, "cloud-session-cache-incomplete");
  assert.equal(strict.diagnostics.coverage.missingSequences, 2);
});

test("Desktop renderer shape (session_ id, limit=200 desc + limit=500 asc offset pages) resolves from the key index", { skip: !hasZstd && "zstd unavailable" }, async (context) => {
  const directory = await makeCacheDirectory(context);
  // 1..1200 events: newest 200 on the first page, full history in ascending
  // 500-row pages keyed by offset, exactly as observed on 2026-09-16.
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${sessionId}/events?limit=200&sort_order=desc`, encode({ data: rows(1200, 1001), next_cursor: "1001" }, "zstd"));
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${sessionId}/events?limit=500&sort_order=asc`, encode({ data: rows(500, 1).reverse(), next_cursor: "500" }, "zstd"));
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${sessionId}/events?limit=500&sort_order=asc&cursor=500`, encode({ data: rows(1000, 501).reverse(), next_cursor: "1000" }, "zstd"));
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${sessionId}/events?limit=500&sort_order=asc&cursor=1000`, encode({ data: rows(1200, 1001).reverse(), next_cursor: null }, "zstd"));

  const store = makeStore(directory);
  const result = await store.refresh(sessionId);
  assert.equal(result.status, "resolved", JSON.stringify(result.diagnostics));
  assert.equal(result.complete, true);
  assert.equal(result.eventCount, 1200);
  assert.equal(result.diagnostics.sources.index.matched, 4);
  assert.equal(result.diagnostics.sources.probe, undefined, "probes are not needed when the index finds the Session");
  assert.equal(result.files[0].usage.length, 600);
  assert.equal(result.files[0].usage.at(-1).total.totalTokens, 600 * 10);
  for (const entry of result.diagnostics.entries) {
    assert.equal(entry.format, "zstd");
    assert.equal(entry.shape.includes(core), false);
  }
});

test("embedded client shape (cse_ id, limit=100 + limit=500&cursor, gzip) resolves for the session_ route", async (context) => {
  const directory = await makeCacheDirectory(context);
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${cseId}/events?limit=100`, encode({ data: rows(1300, 1201), next_cursor: "1201" }, "gzip"));
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${cseId}/events?limit=500`, encode({ data: rows(1300, 801), next_cursor: "801" }, "gzip"));
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${cseId}/events?limit=500&cursor=801`, encode({ data: rows(800, 301), next_cursor: "301" }, "gzip"));
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${cseId}/events?limit=500&cursor=301`, encode({ data: rows(300, 1), next_cursor: null }, "gzip"));

  const result = await makeStore(directory).refresh(sessionId);
  assert.equal(result.status, "resolved", JSON.stringify(result.diagnostics));
  assert.equal(result.complete, true);
  assert.equal(result.eventCount, 1300);
  assert.deepEqual(result.diagnostics.variants, [sessionId, cseId]);
  assert.ok(result.diagnostics.entries.every((entry) => entry.format === "gzip"));
});

test("an open SSE stream fills the live tail and grows between refreshes", async (context) => {
  const directory = await makeCacheDirectory(context);
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${cseId}/events?limit=500`, encode({ data: rows(145, 1), next_cursor: null }, "raw"));
  const frames = (list) => list.map((row) => `data: ${JSON.stringify(row)}\n\n`).join("");
  const streamPath = await writeSimpleCacheEntry(
    directory,
    `https://claude.ai/v1/code/sessions/${cseId}/events/stream?from_sequence_num=146`,
    Buffer.from(`: keepalive\n\n${frames(rows(150, 146).reverse())}`),
    { open: true },
  );

  const store = makeStore(directory);
  const first = await store.refresh(sessionId);
  assert.equal(first.status, "resolved", JSON.stringify(first.diagnostics));
  assert.equal(first.complete, true);
  assert.equal(first.eventCount, 150);
  const streamEntry = first.diagnostics.entries.find((entry) => entry.kind === "events-stream");
  assert.equal(streamEntry.body, "sse");
  assert.equal(streamEntry.truncated, true);
  assert.equal(streamEntry.events, 5);

  // The connection stays open and Chromium appends as events arrive; a frame
  // may be cut mid-JSON when the file is read.
  await appendFile(streamPath, `${frames(rows(154, 151).reverse())}data: {"sequence_num": 155, "payl`);
  const second = await store.refresh(sessionId);
  assert.equal(second.eventCount, 154);
  assert.equal(second.complete, true);
  assert.equal(second.files[0].usage.at(-1).total.totalTokens, 77 * 10);
});

test("rows without a payload still count toward sequence coverage", async (context) => {
  const directory = await makeCacheDirectory(context);
  const data = rows(20, 1);
  data[5] = { sequence_num: data[5].sequence_num, created_at: data[5].created_at, payload: null };
  data[9] = { sequence_num: data[9].sequence_num, created_at: data[9].created_at };
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${sessionId}/events?limit=200&sort_order=desc`, encode({ data, next_cursor: null }, "raw"));
  const result = await makeStore(directory).refresh(sessionId);
  assert.equal(result.status, "resolved");
  assert.equal(result.complete, true);
  assert.equal(result.eventCount, 20);
});

test("child-Agent events are split into a subagent file so root Context stays exact", async (context) => {
  const directory = await makeCacheDirectory(context);
  const data = [
    assistant(6, "agent-2", { input_tokens: 999, output_tokens: 1 }, { parent_tool_use_id: "toolu_1" }),
    assistant(5, "root-2", { input_tokens: 50, output_tokens: 5 }),
    user(4, { parent_tool_use_id: "toolu_1" }),
    assistant(3, "agent-1", { input_tokens: 700, output_tokens: 1 }, { parent_tool_use_id: "toolu_1" }),
    assistant(2, "root-1", { input_tokens: 40, output_tokens: 5 }),
    user(1),
  ];
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${sessionId}/events?limit=200&sort_order=desc`, encode({ data, next_cursor: null }, "raw"));
  const result = await makeStore(directory).refresh(sessionId);
  assert.equal(result.status, "resolved");
  assert.equal(result.files.length, 2);
  const [root, agents] = result.files;
  assert.equal(root.meta.threadSource, "user");
  assert.equal(agents.meta.threadSource, "subagent");
  assert.equal(agents.meta.sessionId, sessionId);
  assert.equal(root.usage.at(-1).contextTokens, 50);
  assert.equal(root.usage.at(-1).total.totalTokens, 100);
  assert.equal(agents.usage.at(-1).total.totalTokens, 1701);
  assert.deepEqual(root.userMessages, [Date.parse(iso(1))], "a child-Agent prompt is not a root turn boundary");
});

test("watch poll responses contribute only events that name the Session", async (context) => {
  const directory = await makeCacheDirectory(context);
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${cseId}/events?limit=100`, encode({ data: rows(3, 1), next_cursor: null }, "raw"));
  await writeSimpleCacheEntry(
    directory,
    "https://claude.ai/v1/code/sessions/watch?exclude_tags=-&resume_token=MTc4%3D%3D",
    encode({
      events: [
        { ...assistant(4, "response-4", smallUsage), session_id: cseId },
        { ...user(5), session_id: "cse_02zzzzzzzzzzzzzzzzzzzzzz" },
        { ...user(6) },
      ],
    }, "raw"),
  );
  const result = await makeStore(directory).refresh(sessionId);
  assert.equal(result.status, "resolved");
  assert.equal(result.eventCount, 4, "the anonymous and foreign rows are ignored");
  assert.equal(result.complete, true);
  const watch = result.diagnostics.entries.find((entry) => entry.kind === "session-watch");
  assert.equal(watch.accepted, 1);
  assert.equal(watch.shape.includes("MTc4"), false, "resume tokens never reach diagnostics");
});

test("rows attributed to another Session inside a page are ignored", async (context) => {
  const directory = await makeCacheDirectory(context);
  const data = rows(4, 1);
  data[0] = { ...data[0], session_id: "cse_02zzzzzzzzzzzzzzzzzzzzzz" };
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${cseId}/events?limit=100`, encode({ data, next_cursor: null }, "raw"));
  const result = await makeStore(directory).refresh(sessionId);
  assert.equal(result.eventCount, 3);
  assert.equal(result.complete, true);
});

test("no cached entry for the Session reports missing with scan diagnostics", async (context) => {
  const directory = await makeCacheDirectory(context);
  const result = await makeStore(directory).refresh(sessionId);
  assert.equal(result.status, "unbound");
  assert.equal(result.reason, "cloud-session-cache-missing");
  assert.equal(result.diagnostics.sources.index.status, "ok");
  assert.equal(result.diagnostics.sources.index.matched, 0);
  assert.ok(result.diagnostics.sources.index.stats.scannedFiles >= 2);
  assert.equal(result.diagnostics.sources.probe.status, "ok");
  assert.equal(result.diagnostics.sources.probe.hits, 0);
});

test("undecodable entries report unreadable rather than missing", async (context) => {
  const directory = await makeCacheDirectory(context);
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${sessionId}/events?limit=200&sort_order=desc`, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
  const result = await makeStore(directory).refresh(sessionId);
  assert.equal(result.status, "unbound");
  assert.equal(result.reason, "cloud-session-cache-unreadable");
  assert.equal(result.diagnostics.entries[0].error, "UNKNOWN_FORMAT");
});

test("a missing cache directory is reported as unavailable", async () => {
  const result = await makeStore("/nonexistent/token-meter/Cache_Data").refresh(sessionId);
  assert.equal(result.status, "unbound");
  assert.equal(result.reason, "cloud-cache-directory-unavailable");
  assert.equal(result.diagnostics.sources.index.status, "error");
  assert.equal(result.diagnostics.sources.probe.status, "error");
});

test("URL probes recover a cursor chain in every known shape when the index is disabled", async (context) => {
  const directory = await makeCacheDirectory(context);
  // First page in the embedded-client shape, older page in the renderer shape:
  // the probe must not assume the chain keeps one parameter style.
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${cseId}/events?limit=100`, encode({ data: rows(8, 5), next_cursor: "5" }, "raw"));
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${cseId}/events?limit=500&sort_order=desc&cursor=5`, encode({ data: rows(4, 1), next_cursor: null }, "raw"));
  const result = await makeStore(directory, { index: false }).refresh(sessionId);
  assert.equal(result.status, "resolved", JSON.stringify(result.diagnostics));
  assert.equal(result.complete, true);
  assert.equal(result.eventCount, 8);
  assert.equal(result.diagnostics.sources.probe.hits, 2);
  assert.ok(result.diagnostics.sources.probe.reads <= 40);
});

test("the store memoizes within the refresh interval and re-reads changed files only", async (context) => {
  const directory = await makeCacheDirectory(context);
  await writeSimpleCacheEntry(directory, `https://claude.ai/v1/code/sessions/${cseId}/events?limit=100`, encode({ data: rows(3, 1), next_cursor: null }, "raw"));
  let reads = 0;
  let clock = 0;
  const { readSimpleCacheEntry } = await import("../integrations/claude-desktop/src/simple-cache.mjs");
  const store = makeStore(directory, {
    refreshIntervalMs: 1_000,
    now: () => clock,
    readEntry: async (...args) => {
      reads += 1;
      return readSimpleCacheEntry(...args);
    },
  });
  const first = await store.refresh(sessionId);
  assert.equal(first.status, "resolved");
  assert.equal(reads, 1);
  assert.equal(await store.refresh(sessionId), first, "memoized within the interval");
  clock += 1_000;
  await store.refresh(sessionId);
  assert.equal(reads, 1, "an unchanged file is not decoded again");
  await store.close();
});

test("buildSimpleCacheEntry round-trips through the compatibility reader", async (context) => {
  const directory = await makeCacheDirectory(context);
  const { readSimpleCacheJson } = await import("../integrations/claude-desktop/src/cloud-session-store.mjs");
  const url = claudeCloudEventsUrl(sessionId);
  await writeFile(path.join(directory, simpleCacheFileName(url)), buildSimpleCacheEntry(url, encode({ data: [], next_cursor: null }, "raw")));
  assert.deepEqual(await readSimpleCacheJson(directory, url), { data: [], next_cursor: null });
  assert.equal(await readSimpleCacheJson(directory, `${url}&missing=1`), null);
});

test("a large cache reports indexing until the first scan completes, and drains in one-shot mode", async (context) => {
  const directory = await makeCacheDirectory(context);
  for (let index = 0; index < 30; index += 1) {
    await writeSimpleCacheEntry(directory, `https://claude.ai/api/organizations/o/conversations/${index}`, Buffer.from("{}"));
  }
  // A shape the probe table does not know, so only the index can find it.
  const url = `https://claude.ai/v1/code/sessions/${cseId}/events?limit=250&sort_order=desc`;
  await writeSimpleCacheEntry(directory, url, encode({ data: rows(3, 1), next_cursor: null }, "raw"));
  const { SimpleCacheKeyIndex } = await import("../integrations/claude-desktop/src/simple-cache.mjs");
  const { isCloudSessionCacheKey } = await import("../integrations/claude-desktop/src/cloud-events.mjs");
  const slowIndex = (now) =>
    new SimpleCacheKeyIndex({
      directory,
      isRelevantKey: isCloudSessionCacheKey,
      maxHeaderReadsPerRefresh: 5,
      // Force the relevant entry to be read last so early ticks see nothing.
      listDirectory: async (dir) => {
        const { readdir } = await import("node:fs/promises");
        const names = await readdir(dir);
        const target = simpleCacheFileName(url);
        return [...names.filter((name) => name !== target), target];
      },
      now,
    });

  // Bridge posture: one batch per tick, honest interim reason.
  let clock = 0;
  const bridge = makeStore(directory, { index: slowIndex(() => clock), now: () => clock });
  const first = await bridge.refresh(sessionId);
  assert.equal(first.status, "unbound");
  assert.equal(first.reason, "cloud-cache-indexing");
  assert.ok(first.diagnostics.sources.index.stats.backlog > 0);
  let result = first;
  for (let tick = 0; tick < 20 && result.status !== "resolved"; tick += 1) {
    clock += 1;
    result = await bridge.refresh(sessionId);
  }
  assert.equal(result.status, "resolved");
  assert.equal(result.eventCount, 3);

  // CLI posture: drain everything before answering.
  const progress = [];
  const oneShot = makeStore(directory, {
    index: slowIndex(Date.now),
    waitForIndex: true,
    onProgress: (event) => progress.push(event.backlog),
  });
  const drained = await oneShot.refresh(sessionId);
  assert.equal(drained.status, "resolved");
  assert.equal(drained.diagnostics.sources.index.stats.backlog, 0);
  assert.ok(progress.length > 0, "progress is reported while draining");
});

test("watch poll entries that fail to decode appear in diagnostics", async (context) => {
  const directory = await makeCacheDirectory(context);
  await writeSimpleCacheEntry(directory, "https://claude.ai/v1/code/sessions/watch?exclude_tags=-&resume_token=abc", Buffer.alloc(0), { open: true });
  await writeSimpleCacheEntry(directory, "https://claude.ai/v1/code/sessions/watch?exclude_tags=-&resume_token=def", Buffer.from([0x01, 0x02, 0x03, 0x04]));
  const result = await makeStore(directory).refresh(sessionId);
  assert.equal(result.status, "unbound");
  assert.equal(result.reason, "cloud-session-cache-missing", "watch failures never masquerade as unreadable Session data");
  assert.equal(result.diagnostics.sources.index.errors, 2);
  const errors = result.diagnostics.entries.filter((entry) => entry.kind === "session-watch").map((entry) => entry.error).sort();
  assert.deepEqual(errors, ["DECODE_FAILED", "UNKNOWN_FORMAT"]);
});
