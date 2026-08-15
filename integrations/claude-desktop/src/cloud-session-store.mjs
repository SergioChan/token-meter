import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { isClaudeCloudSessionId } from "./desktop-session-store.mjs";
import { parseClaudeTranscriptValue } from "./transcript-store.mjs";

const SIMPLE_CACHE_HEADER_BYTES = 24;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CACHE_ENTRY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_EVENTS = 10_000;

function emptyBreakdown() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function addBreakdown(target, source) {
  target.totalTokens += source.totalTokens;
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  return { ...target };
}

function cacheKey(url) {
  return `1/0/${url}`;
}

export function simpleCacheFileName(url) {
  const digest = createHash("sha1").update(cacheKey(url)).digest();
  return `${Buffer.from(digest.subarray(0, 8)).reverse().toString("hex")}_0`;
}

export function claudeCloudEventsUrl(sessionId, cursor = null) {
  if (!isClaudeCloudSessionId(sessionId)) {
    throw new TypeError("invalid Claude cloud Session identifier");
  }
  const url = new URL(
    `/v1/code/sessions/${sessionId}/events`,
    "https://claude.ai",
  );
  url.searchParams.set("limit", cursor == null ? "50" : "500");
  url.searchParams.set("sort_order", "desc");
  if (cursor != null) url.searchParams.set("cursor", cursor);
  return url.toString();
}

export async function readSimpleCacheJson(
  cacheDirectory,
  url,
  {
    maxCacheEntryBytes = DEFAULT_MAX_CACHE_ENTRY_BYTES,
    maxDecodedBytes = DEFAULT_MAX_DECODED_BYTES,
  } = {},
) {
  const filePath = path.join(cacheDirectory, simpleCacheFileName(url));
  let source;
  try {
    source = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    source.length < SIMPLE_CACHE_HEADER_BYTES ||
    source.length > maxCacheEntryBytes
  ) {
    return null;
  }

  const keyLength = source.readUInt32LE(12);
  const keyStart = SIMPLE_CACHE_HEADER_BYTES;
  const bodyStart = keyStart + keyLength;
  if (
    keyLength <= 0 ||
    bodyStart + ZSTD_MAGIC.length > source.length ||
    source.subarray(keyStart, bodyStart).toString("utf8") !== cacheKey(url) ||
    !source.subarray(bodyStart, bodyStart + ZSTD_MAGIC.length).equals(ZSTD_MAGIC)
  ) {
    return null;
  }

  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("Claude cloud telemetry requires Node.js with zstd support");
  }
  const decoded = zlib.zstdDecompressSync(source.subarray(bodyStart), {
    maxOutputLength: maxDecodedBytes,
  });
  if (decoded.length > maxDecodedBytes) return null;
  return JSON.parse(decoded.toString("utf8"));
}

function safeSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function safeCursor(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return null;
  }
  return /^[A-Za-z0-9._~-]+$/.test(value) ? value : null;
}

function buildMetricFile(sessionId, events) {
  const responses = new Map();
  const terminals = new Map();
  const userMessages = new Set();
  const contextCompactions = new Set();

  for (const event of events) {
    const payload = event.payload;
    if (payload == null || typeof payload !== "object") continue;
    const value = payload.timestamp == null && event.created_at != null
      ? { ...payload, timestamp: event.created_at }
      : payload;
    const parsed = parseClaudeTranscriptValue(value);
    if (parsed?.kind === "assistantUsage") {
      responses.set(parsed.responseId, parsed);
      if (parsed.terminal != null) terminals.set(parsed.responseId, parsed);
    } else if (parsed?.kind === "assistantTerminal") {
      terminals.set(parsed.responseId, parsed);
    } else if (parsed?.kind === "userMessage") {
      userMessages.add(parsed.timestampMs);
    } else if (parsed?.kind === "contextCompacted") {
      contextCompactions.add(parsed.timestampMs);
    }
  }

  const orderedResponses = [...responses.values()].sort(
    (left, right) =>
      left.timestampMs - right.timestampMs ||
      left.responseId.localeCompare(right.responseId),
  );
  const cumulative = emptyBreakdown();
  const usage = orderedResponses.map((event) => ({
    kind: "usage",
    timestampMs: event.timestampMs,
    total: addBreakdown(cumulative, event.usage),
    last: null,
    contextTokens: event.usage.inputTokens,
    contextWindow: null,
  }));
  const timestamps = [
    ...orderedResponses.map((event) => event.timestampMs),
    ...userMessages,
  ].filter(Number.isFinite);
  const startedAtMs = timestamps.length > 0 ? Math.min(...timestamps) : null;
  const modifiedMs = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  return {
    path: `claude-cloud-cache:${sessionId}`,
    discoveredId: sessionId,
    modifiedMs,
    meta: {
      id: sessionId,
      sessionId,
      source: "claude-cloud-cache",
      threadSource: "user",
      originator: "claude-code",
      cwd: null,
      timestampMs: startedAtMs,
    },
    usage,
    userMessages: [...userMessages].sort((left, right) => left - right),
    turnCompletions: [...terminals.values()]
      .filter((event) => event.terminal === "complete")
      .map((event) => event.timestampMs)
      .sort((left, right) => left - right),
    turnAborts: [...terminals.values()]
      .filter((event) => event.terminal === "aborted")
      .map((event) => event.timestampMs)
      .sort((left, right) => left - right),
    contextCompactions: [...contextCompactions].sort(
      (left, right) => left - right,
    ),
    diagnostics: {
      source: "claude-cloud-http-cache",
      eventCount: events.length,
    },
  };
}

export class ClaudeCloudSessionStore {
  constructor({
    cacheDirectory = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "Cache",
      "Cache_Data",
    ),
    responseReader = null,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    maxPages = DEFAULT_MAX_PAGES,
    maxEvents = DEFAULT_MAX_EVENTS,
    now = Date.now,
  } = {}) {
    this.cacheDirectory = cacheDirectory;
    this.responseReader =
      responseReader ?? ((url) => readSimpleCacheJson(cacheDirectory, url));
    this.refreshIntervalMs = refreshIntervalMs;
    this.maxPages = maxPages;
    this.maxEvents = maxEvents;
    this.now = now;
    this.memo = null;
  }

  async refresh(sessionId) {
    if (!isClaudeCloudSessionId(sessionId)) {
      return {
        status: "unbound",
        desktopSessionId: sessionId,
        reason: "invalid-cloud-session-id",
      };
    }
    const nowMs = this.now();
    if (
      this.memo?.sessionId === sessionId &&
      nowMs - this.memo.atMs < this.refreshIntervalMs
    ) {
      return this.memo.value;
    }

    const value = await this.#load(sessionId);
    this.memo = { sessionId, atMs: nowMs, value };
    return value;
  }

  async #load(sessionId) {
    const events = new Map();
    const visitedCursors = new Set();
    let cursor = null;
    let complete = false;

    for (let page = 0; page < this.maxPages; page += 1) {
      const response = await this.responseReader(
        claudeCloudEventsUrl(sessionId, cursor),
      );
      if (response == null) {
        return {
          status: "unbound",
          desktopSessionId: sessionId,
          reason: page === 0
            ? "cloud-session-cache-missing"
            : "cloud-session-cache-incomplete",
        };
      }
      if (!Array.isArray(response.data)) {
        return {
          status: "unbound",
          desktopSessionId: sessionId,
          reason: "invalid-cloud-session-cache",
        };
      }
      for (const event of response.data) {
        const sequence = safeSequence(event?.sequence_num);
        if (sequence == null || event?.payload == null) continue;
        events.set(sequence, event);
        if (events.size > this.maxEvents) {
          return {
            status: "unbound",
            desktopSessionId: sessionId,
            reason: "cloud-session-event-limit",
          };
        }
      }

      if (response.next_cursor == null) {
        complete = true;
        break;
      }
      const nextCursor = safeCursor(response.next_cursor);
      if (nextCursor == null || visitedCursors.has(nextCursor)) break;
      visitedCursors.add(nextCursor);
      cursor = nextCursor;
    }

    const sequences = [...events.keys()].sort((left, right) => left - right);
    const contiguous =
      sequences.length > 0 &&
      sequences[0] === 1 &&
      sequences.every((sequence, index) => sequence === index + 1);
    if (!complete || !contiguous) {
      return {
        status: "unbound",
        desktopSessionId: sessionId,
        reason: "cloud-session-cache-incomplete",
      };
    }

    const orderedEvents = sequences.map((sequence) => events.get(sequence));
    return {
      status: "resolved",
      desktopSessionId: sessionId,
      eventCount: orderedEvents.length,
      files: [buildMetricFile(sessionId, orderedEvents)],
    };
  }
}
