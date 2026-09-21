// Cloud Code Session usage from Claude Desktop's local HTTP cache.
//
// A cloud Session's transcript lives in Anthropic's sandbox, not on this Mac.
// The only local copies of its events are the responses Claude Desktop cached
// while displaying it. Earlier versions of this store computed one exact cache
// file name from a hard-coded URL (`/events?limit=50&sort_order=desc`) and
// followed `next_cursor` links from there. Desktop changed the page size, the
// identifier prefix, the sort order, and the pagination style within weeks,
// which left the meter permanently unbound for cloud Sessions.
//
// This version layers several independent sources and merges everything by
// `sequence_num`:
//
//   1. Key index   — scan the cache directory once, remember every key that
//                    mentions `/code/sessions/`, and match the bound Session
//                    under every known identifier prefix and any query string.
//                    JSON pages, SSE stream bodies, and `watch` poll responses
//                    are all harvested.
//   2. URL probes  — when the directory cannot be listed, compute file names
//                    for every request shape observed so far and read them
//                    directly, following cursor chains in each style.
//
// Coverage is reported honestly: a contiguous 1..N sequence is `complete`;
// anything else is returned as a partial binding with the gap counted, or
// withheld when `allowPartial` is false. Message content is discarded at the
// parse boundary exactly as before.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isClaudeCloudSessionId } from "./desktop-session-store.mjs";
import { parseClaudeTranscriptValue } from "./transcript-store.mjs";
import {
  decodeCacheBody,
  parseSimpleCacheHeader,
  findStreamEnd,
  readSimpleCacheEntry,
  SimpleCacheKeyIndex,
} from "./simple-cache.mjs";
import {
  classifyCloudCacheKey,
  cloudHostSuffixes,
  cloudIdPrefixes,
  cloudSessionIdCore,
  cloudSessionIdVariants,
  describeCloudUrl,
  extractCloudEvents,
  isCloudSessionCacheKey,
} from "./cloud-events.mjs";

const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_CACHE_ENTRY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_EVENTS = 20_000;
const DEFAULT_MAX_MATCHED_ENTRIES = 200;
const DEFAULT_MAX_WATCH_ENTRIES = 25;
const DIAGNOSTIC_ENTRY_LIMIT = 40;

// Every first-page request shape seen so far. New shapes only need a row here
// for the probe fallback; the key index already matches them by identity.
export const KNOWN_FIRST_PAGE_SHAPES = Object.freeze([
  { limit: 50, sortOrder: "desc" },
  { limit: 200, sortOrder: "desc" },
  { limit: 100, sortOrder: null },
  { limit: 500, sortOrder: null },
  { limit: 500, sortOrder: "desc" },
  { limit: 500, sortOrder: "asc" },
]);
export const KNOWN_CURSOR_PAGE_SHAPES = Object.freeze([
  { limit: 500, sortOrder: "desc" },
  { limit: 500, sortOrder: null },
  { limit: 500, sortOrder: "asc" },
]);

export function defaultClaudeCacheDirectory() {
  return path.join(os.homedir(), "Library", "Application Support", "Claude", "Cache", "Cache_Data");
}

export function defaultCloudCacheIndexPath() {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Token Meter",
    "State",
    "claude-cloud-cache-index.json",
  );
}

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

/** Build an events URL for any identifier form and request shape. */
export function claudeCloudEventsUrlFor(
  sessionRef,
  { limit = 50, sortOrder = "desc", cursor = null, origin = "https://claude.ai" } = {},
) {
  if (cloudSessionIdCore(sessionRef) == null) {
    throw new TypeError("invalid Claude cloud Session identifier");
  }
  const url = new URL(`/v1/code/sessions/${sessionRef}/events`, origin);
  url.searchParams.set("limit", String(limit));
  if (sortOrder != null) url.searchParams.set("sort_order", sortOrder);
  if (cursor != null) url.searchParams.set("cursor", String(cursor));
  return url.toString();
}

/** Legacy shape kept for compatibility: limit 50 first page, 500 with cursor. */
export function claudeCloudEventsUrl(sessionId, cursor = null) {
  if (!isClaudeCloudSessionId(sessionId)) {
    throw new TypeError("invalid Claude cloud Session identifier");
  }
  return claudeCloudEventsUrlFor(sessionId, {
    limit: cursor == null ? 50 : 500,
    sortOrder: "desc",
    cursor,
  });
}

/**
 * Compatibility helper: read and decode one cached JSON response by URL.
 * Returns null when the entry is absent or not decodable.
 */
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
  if (source.length > maxCacheEntryBytes) return null;
  const header = parseSimpleCacheHeader(source);
  if (header?.key == null || header.key !== cacheKey(url)) return null;
  const end = findStreamEnd(source, header.bodyStart);
  const body = source.subarray(header.bodyStart, end ?? source.length);
  let decoded;
  try {
    decoded = decodeCacheBody(body, { maxDecodedBytes });
  } catch (error) {
    if (error?.code === "ZSTD_UNSUPPORTED") {
      throw new Error("Claude cloud telemetry requires Node.js with zstd support");
    }
    return null;
  }
  try {
    return JSON.parse(decoded.bytes.toString("utf8"));
  } catch {
    return null;
  }
}

function safeCursor(value) {
  if (value == null) return null;
  const text = String(value);
  if (text.length === 0 || text.length > 512 || /[\s\0]/.test(text)) return null;
  return text;
}

function isSubagentPayload(payload) {
  return (
    payload.parent_tool_use_id != null ||
    payload.parentToolUseId != null ||
    payload.isSidechain === true
  );
}

function fileFromEvents(sessionId, id, threadSource, records, { startedAtMs, coverage, complete, diagnostics }) {
  const responses = new Map();
  const terminals = new Map();
  const userMessages = new Set();
  const contextCompactions = new Set();

  for (const parsed of records) {
    if (parsed.kind === "assistantUsage") {
      responses.set(parsed.responseId, parsed);
      if (parsed.terminal != null) terminals.set(parsed.responseId, parsed);
    } else if (parsed.kind === "assistantTerminal") {
      terminals.set(parsed.responseId, parsed);
    } else if (parsed.kind === "userMessage" && threadSource === "user") {
      userMessages.add(parsed.timestampMs);
    } else if (parsed.kind === "contextCompacted" && threadSource === "user") {
      contextCompactions.add(parsed.timestampMs);
    }
  }

  const orderedResponses = [...responses.values()].sort(
    (left, right) =>
      left.timestampMs - right.timestampMs || left.responseId.localeCompare(right.responseId),
  );
  const cumulative = emptyBreakdown();
  const usage = orderedResponses.map((event) => ({
    kind: "usage",
    timestampMs: event.timestampMs,
    total: addBreakdown(cumulative, event.usage),
    last: null,
    contextTokens: threadSource === "user" ? event.usage.inputTokens : null,
    contextWindow: null,
  }));
  const timestamps = [...orderedResponses.map((event) => event.timestampMs), ...userMessages].filter(
    Number.isFinite,
  );
  const sortedNumbers = (set) => [...set].sort((left, right) => left - right);

  return {
    path: `claude-cloud-cache:${sessionId}${threadSource === "user" ? "" : ":agents"}`,
    discoveredId: id,
    modifiedMs: timestamps.length > 0 ? Math.max(...timestamps) : 0,
    meta: {
      id,
      sessionId,
      source: "claude-cloud-cache",
      threadSource,
      originator: "claude-code",
      cwd: null,
      timestampMs: startedAtMs,
    },
    usage,
    userMessages: sortedNumbers(userMessages),
    turnCompletions: [...terminals.values()]
      .filter((event) => event.terminal === "complete")
      .map((event) => event.timestampMs)
      .sort((left, right) => left - right),
    turnAborts: [...terminals.values()]
      .filter((event) => event.terminal === "aborted")
      .map((event) => event.timestampMs)
      .sort((left, right) => left - right),
    contextCompactions: sortedNumbers(contextCompactions),
    diagnostics: { ...diagnostics, complete, coverage },
  };
}

export function buildMetricFiles(sessionId, orderedEvents, { complete = true, coverage = null, diagnostics = {} } = {}) {
  const rootRecords = [];
  const agentRecords = [];
  let startedAtMs = null;
  for (const event of orderedEvents) {
    const payload = event.payload;
    if (payload == null || typeof payload !== "object") continue;
    const value =
      payload.timestamp == null && event.createdAt != null
        ? { ...payload, timestamp: event.createdAt }
        : payload;
    const parsed = parseClaudeTranscriptValue(value);
    if (parsed == null) continue;
    if (startedAtMs == null || parsed.timestampMs < startedAtMs) startedAtMs = parsed.timestampMs;
    (isSubagentPayload(payload) ? agentRecords : rootRecords).push(parsed);
  }
  const shared = {
    startedAtMs,
    coverage,
    complete,
    diagnostics: { source: "claude-cloud-http-cache", eventCount: orderedEvents.length, ...diagnostics },
  };
  const files = [fileFromEvents(sessionId, sessionId, "user", rootRecords, shared)];
  if (agentRecords.some((record) => record.kind === "assistantUsage")) {
    files.push(fileFromEvents(sessionId, `${sessionId}:agents`, "subagent", agentRecords, shared));
  }
  return files;
}

export class ClaudeCloudSessionStore {
  constructor({
    cacheDirectory = defaultClaudeCacheDirectory(),
    index = undefined,
    indexPersistPath = defaultCloudCacheIndexPath(),
    responseReader = null,
    refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    maxPages = DEFAULT_MAX_PAGES,
    maxEvents = DEFAULT_MAX_EVENTS,
    maxMatchedEntries = DEFAULT_MAX_MATCHED_ENTRIES,
    maxWatchEntries = DEFAULT_MAX_WATCH_ENTRIES,
    maxCacheEntryBytes = DEFAULT_MAX_CACHE_ENTRY_BYTES,
    maxDecodedBytes = DEFAULT_MAX_DECODED_BYTES,
    allowPartial = true,
    // One-shot callers (the CLI) drain the whole key index before judging;
    // the long-lived bridge spreads the first scan over its 1 s ticks and
    // reports `cloud-cache-indexing` until the backlog is gone.
    waitForIndex = false,
    indexDrainTimeoutMs = 120_000,
    onProgress = null,
    prefixes = cloudIdPrefixes(),
    hostSuffixes = cloudHostSuffixes(),
    readEntry = readSimpleCacheEntry,
    now = Date.now,
  } = {}) {
    this.cacheDirectory = cacheDirectory;
    this.hostSuffixes = hostSuffixes;
    this.prefixes = prefixes;
    this.index =
      index === false
        ? null
        : index ??
          new SimpleCacheKeyIndex({
            directory: cacheDirectory,
            isRelevantKey: (key) => isCloudSessionCacheKey(key, { hostSuffixes }),
            persistPath: indexPersistPath,
            now,
          });
    // A legacy `responseReader(url)` is honored by the probe source so callers
    // and tests that inject one keep working.
    this.responseReader = responseReader;
    this.refreshIntervalMs = refreshIntervalMs;
    this.maxPages = maxPages;
    this.maxEvents = maxEvents;
    this.maxMatchedEntries = maxMatchedEntries;
    this.maxWatchEntries = maxWatchEntries;
    this.maxCacheEntryBytes = maxCacheEntryBytes;
    this.maxDecodedBytes = maxDecodedBytes;
    this.allowPartial = allowPartial;
    this.waitForIndex = waitForIndex;
    this.indexDrainTimeoutMs = indexDrainTimeoutMs;
    this.onProgress = onProgress;
    this.readEntry = readEntry;
    this.now = now;
    this.memo = null;
    this.entryMemo = new Map();
  }

  async refresh(sessionId) {
    if (!isClaudeCloudSessionId(sessionId)) {
      return { status: "unbound", desktopSessionId: sessionId, reason: "invalid-cloud-session-id" };
    }
    const nowMs = this.now();
    if (this.memo?.sessionId === sessionId && nowMs - this.memo.atMs < this.refreshIntervalMs) {
      return this.memo.value;
    }
    const value = await this.#load(sessionId);
    this.memo = { sessionId, atMs: nowMs, value };
    return value;
  }

  async close() {
    await this.index?.close?.();
  }

  #unbound(sessionId, reason, diagnostics) {
    return { status: "unbound", desktopSessionId: sessionId, reason, diagnostics };
  }

  #mergeEvent(events, event, variants, { requireSessionId }) {
    if (event.sessionId != null && !variants.includes(event.sessionId)) return false;
    if (requireSessionId && event.sessionId == null) return false;
    const existing = events.get(event.sequence);
    if (existing == null || (existing.payload == null && event.payload != null)) {
      events.set(event.sequence, event);
    }
    return true;
  }

  async #harvestFile(filePath, key, kind, shape) {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      return { shape, kind, error: error.code ?? "STAT_FAILED", events: [] };
    }
    const memo = this.entryMemo.get(filePath);
    if (memo && memo.sizeBytes === fileStat.size && memo.modifiedMs === fileStat.mtimeMs) {
      return memo.result;
    }
    const result = {
      shape,
      kind,
      bytes: fileStat.size,
      modifiedMs: fileStat.mtimeMs,
      format: null,
      truncated: null,
      headers: null,
      events: [],
      cursor: null,
      error: null,
    };
    try {
      const entry = await this.readEntry(filePath, { maxEntryBytes: this.maxCacheEntryBytes });
      if (entry == null) {
        result.error = "NOT_A_CACHE_ENTRY";
      } else {
        result.truncated = entry.truncated;
        result.headers = entry.headers;
        const decoded = decodeCacheBody(entry.body, { maxDecodedBytes: this.maxDecodedBytes });
        result.format = decoded.format;
        const extracted = extractCloudEvents(decoded.bytes.toString("utf8"));
        result.bodyKind = extracted.format;
        result.events = extracted.events;
        result.cursor = extracted.cursor ?? null;
        if (extracted.errors?.length) result.parseErrors = extracted.errors.slice(0, 3);
      }
    } catch (error) {
      result.error = error?.code ?? error?.message ?? "READ_FAILED";
    }
    this.entryMemo.set(filePath, { sizeBytes: fileStat.size, modifiedMs: fileStat.mtimeMs, result });
    return result;
  }

  async #indexSource(variants, events, diagnostics) {
    const summary = { status: "skipped", matched: 0, harvested: 0, errors: 0 };
    diagnostics.sources.index = summary;
    if (this.index == null) return;
    try {
      await this.index.refresh();
      if (this.waitForIndex) {
        const deadline = this.now() + this.indexDrainTimeoutMs;
        while (this.index.stats.backlog > 0 && this.now() < deadline) {
          this.onProgress?.({ phase: "indexing", ...this.index.stats });
          await this.index.refresh();
        }
      }
      summary.status = "ok";
    } catch (error) {
      summary.status = "error";
      summary.error = error?.code ?? error?.message ?? String(error);
      return;
    } finally {
      summary.stats = { ...this.index.stats };
    }

    const classified = [];
    const watch = [];
    for (const entry of this.index.find()) {
      const info = classifyCloudCacheKey(entry.key, variants, { hostSuffixes: this.hostSuffixes });
      if (info == null) continue;
      if (info.kind === "events-page" || info.kind === "events-stream") classified.push({ ...entry, ...info });
      else if (info.kind === "session-watch") watch.push({ ...entry, ...info });
    }
    summary.matched = classified.length;
    summary.watchCandidates = watch.length;

    const touched = new Set();
    const work = [
      ...classified.slice(0, this.maxMatchedEntries).map((entry) => ({ entry, requireSessionId: false })),
    ];
    if (watch.length > 0) {
      // Watch responses are not Session-scoped; only the newest few are worth
      // decoding, and their events must name the Session explicitly.
      const withTimes = await Promise.all(
        watch.map(async (entry) => {
          try {
            return { entry, modifiedMs: (await stat(entry.path)).mtimeMs };
          } catch {
            return null;
          }
        }),
      );
      withTimes
        .filter(Boolean)
        .sort((left, right) => right.modifiedMs - left.modifiedMs)
        .slice(0, this.maxWatchEntries)
        .forEach(({ entry }) => work.push({ entry, requireSessionId: true }));
    }

    for (const { entry, requireSessionId } of work) {
      touched.add(entry.path);
      const result = await this.#harvestFile(entry.path, entry.key, entry.kind, entry.shape);
      let accepted = 0;
      for (const event of result.events) {
        if (this.#mergeEvent(events, event, variants, { requireSessionId })) accepted += 1;
      }
      if (result.error) summary.errors += 1;
      else if (accepted > 0 || entry.kind !== "session-watch") summary.harvested += 1;
      // Session-scoped entries are always listed; watch polls only when they
      // contributed or failed, so a healthy poll stream does not flood the log.
      if (accepted > 0 || result.error || entry.kind !== "session-watch") {
        this.#recordEntry(diagnostics, { ...result, source: "index", accepted });
      }
      if (events.size > this.maxEvents) break;
    }
    for (const filePath of [...this.entryMemo.keys()]) {
      if (!touched.has(filePath)) this.entryMemo.delete(filePath);
    }
  }

  async #readProbe(url) {
    if (this.responseReader) {
      const response = await this.responseReader(url);
      if (response == null) return null;
      const extracted = extractCloudEvents(JSON.stringify(response));
      return { format: "injected", ...extracted };
    }
    const filePath = path.join(this.cacheDirectory, simpleCacheFileName(url));
    try {
      await stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const result = await this.#harvestFile(filePath, cacheKey(url), "events-page", describeCloudUrl(new URL(url)));
    if (result.error) throw Object.assign(new Error(result.error), { code: result.error });
    return result;
  }

  async #probeSource(variants, events, diagnostics) {
    const summary = { status: "ok", reads: 0, hits: 0, errors: 0 };
    diagnostics.sources.probe = summary;
    if (this.responseReader == null) {
      try {
        const directoryStat = await stat(this.cacheDirectory);
        if (!directoryStat.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
      } catch (error) {
        summary.status = "error";
        summary.error = error?.code ?? error?.message ?? String(error);
        return;
      }
    }
    const core = cloudSessionIdCore(variants[0]);
    let reads = 0;
    const visited = new Set();
    const queue = [];
    for (const sessionRef of variants) {
      for (const shape of KNOWN_FIRST_PAGE_SHAPES) {
        queue.push({ sessionRef, shape, cursor: null });
      }
    }
    while (queue.length > 0 && reads < this.maxPages * variants.length) {
      const { sessionRef, shape, cursor } = queue.shift();
      const url = claudeCloudEventsUrlFor(sessionRef, { ...shape, cursor });
      if (visited.has(url)) continue;
      visited.add(url);
      reads += 1;
      let result;
      try {
        result = await this.#readProbe(url);
      } catch (error) {
        summary.errors += 1;
        summary.lastError = error?.code ?? error?.message;
        continue;
      }
      if (result == null) continue;
      summary.hits += 1;
      let accepted = 0;
      for (const event of result.events ?? []) {
        if (this.#mergeEvent(events, event, variants, { requireSessionId: false })) accepted += 1;
      }
      this.#recordEntry(diagnostics, {
        shape: describeCloudUrl(new URL(url), core),
        kind: "events-page",
        format: result.format ?? null,
        events: result.events ?? [],
        accepted,
        source: "probe",
      });
      const nextCursor = safeCursor(result.cursor);
      if (nextCursor != null) {
        for (const nextShape of KNOWN_CURSOR_PAGE_SHAPES) {
          queue.unshift({ sessionRef, shape: nextShape, cursor: nextCursor });
        }
        queue.unshift({ sessionRef, shape, cursor: nextCursor });
      }
      if (events.size > this.maxEvents) break;
    }
    summary.reads = reads;
  }

  #recordEntry(diagnostics, result) {
    if (diagnostics.entries.length >= DIAGNOSTIC_ENTRY_LIMIT) return;
    diagnostics.entries.push({
      source: result.source,
      kind: result.kind,
      shape: result.shape,
      format: result.format ?? null,
      body: result.bodyKind ?? null,
      bytes: result.bytes ?? null,
      modifiedMs: result.modifiedMs ?? null,
      truncated: result.truncated ?? null,
      contentEncoding: result.headers?.contentEncoding ?? null,
      cacheControl: result.headers?.cacheControl ?? null,
      events: result.events?.length ?? 0,
      accepted: result.accepted ?? null,
      error: result.error ?? null,
    });
  }

  async #load(sessionId) {
    const variants = cloudSessionIdVariants(sessionId, { prefixes: this.prefixes });
    const diagnostics = {
      variants,
      cacheDirectory: this.cacheDirectory,
      sources: {},
      entries: [],
    };
    if (variants.length === 0) {
      return this.#unbound(sessionId, "invalid-cloud-session-id", diagnostics);
    }

    const events = new Map();
    await this.#indexSource(variants, events, diagnostics);
    if (events.size === 0) {
      await this.#probeSource(variants, events, diagnostics);
    }

    const entries = diagnostics.entries;
    if (events.size === 0) {
      const indexSource = diagnostics.sources.index;
      const indexError = indexSource?.status === "error";
      const probeErrors = diagnostics.sources.probe?.errors ?? 0;
      const sessionEntries = entries.filter((entry) => entry.kind !== "session-watch");
      const decodeErrors = sessionEntries.filter((entry) => entry.error).length;
      let reason = "cloud-session-cache-missing";
      if (indexError && (diagnostics.sources.probe?.status === "error" || probeErrors > 0)) {
        reason = "cloud-cache-directory-unavailable";
      } else if (sessionEntries.length > 0 && decodeErrors === sessionEntries.length) {
        reason = "cloud-session-cache-unreadable";
      } else if (sessionEntries.length > 0) {
        reason = "cloud-session-cache-empty";
      } else if (indexSource?.status === "ok" && (indexSource.stats?.backlog ?? 0) > 0) {
        // The first scan of a large cache is still in progress; "missing"
        // would be a claim the index cannot back yet.
        reason = "cloud-cache-indexing";
      }
      return this.#unbound(sessionId, reason, diagnostics);
    }
    if (events.size > this.maxEvents) {
      return this.#unbound(sessionId, "cloud-session-event-limit", diagnostics);
    }

    const sequences = [...events.keys()].sort((left, right) => left - right);
    const maxSequence = sequences.at(-1);
    const coverage = {
      knownSequences: sequences.length,
      firstSequence: sequences[0],
      lastSequence: maxSequence,
      maxSequence,
      missingSequences: maxSequence - sequences.length,
    };
    const complete = coverage.missingSequences === 0;
    if (!complete && !this.allowPartial) {
      return this.#unbound(sessionId, "cloud-session-cache-incomplete", { ...diagnostics, coverage });
    }

    const orderedEvents = sequences.map((sequence) => events.get(sequence));
    const withPayload = orderedEvents.filter((event) => event.payload != null);
    if (withPayload.length === 0) {
      return this.#unbound(sessionId, "cloud-session-cache-empty", { ...diagnostics, coverage });
    }
    return {
      status: "resolved",
      desktopSessionId: sessionId,
      eventCount: orderedEvents.length,
      complete,
      coverage,
      files: buildMetricFiles(sessionId, orderedEvents, { complete, coverage }),
      diagnostics: { ...diagnostics, coverage },
    };
  }
}
