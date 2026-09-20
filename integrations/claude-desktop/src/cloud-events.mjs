// Claude cloud Code Session event discovery and extraction.
//
// Claude Desktop reaches the same Session through more than one client and
// more than one identifier form, and the request shapes have changed several
// times in a few months. Observed on a production install between 2026-07 and
// 2026-09 (identifiers redacted):
//
//   /v1/code/sessions/session_<id>/events?limit=50&sort_order=desc
//   /v1/code/sessions/session_<id>/events?limit=200&sort_order=desc
//   /v1/code/sessions/session_<id>/events?limit=500&sort_order=asc&cursor=500
//   /v1/code/sessions/session_<id>/events?limit=500&sort_order=desc&cursor=86
//   /v1/code/sessions/cse_<id>/events?limit=100
//   /v1/code/sessions/cse_<id>/events?limit=500&cursor=1769
//   /v1/code/sessions/cse_<id>/events/stream?from_sequence_num=146   (SSE)
//   /v1/code/sessions/watch?exclude_tags=-&resume_token=…            (poll)
//
// Nothing in this module assumes a specific limit, sort order, cursor
// format, or identifier prefix. It matches the Session identity inside any
// URL and pulls `sequence_num` + `payload` records out of whatever the body
// turns out to be: a JSON page, an SSE stream, or a wrapper around either.
//
// Message content is never inspected here; only structure is read.

const ID_CORE = /^(?:[a-z]{2,12}_)?([0-9A-Za-z]{24})$/;
export const DEFAULT_CLOUD_ID_PREFIXES = ["session_", "cse_"];
export const DEFAULT_CLOUD_HOST_SUFFIXES = ["claude.ai", "anthropic.com"];
const MAX_NESTING = 4;

export function cloudSessionIdCore(value) {
  if (typeof value !== "string") return null;
  const match = ID_CORE.exec(value);
  return match ? match[1] : null;
}

function splitList(value) {
  return typeof value === "string"
    ? value.split(",").map((part) => part.trim()).filter(Boolean)
    : [];
}

/** Prefixes to try, with an environment override for future Desktop changes. */
export function cloudIdPrefixes(env = process.env) {
  const extra = splitList(env?.TOKEN_METER_CLAUDE_CLOUD_ID_PREFIXES).filter((prefix) =>
    /^[a-z]{2,12}_$/.test(prefix),
  );
  return [...new Set([...DEFAULT_CLOUD_ID_PREFIXES, ...extra])];
}

export function cloudHostSuffixes(env = process.env) {
  const extra = splitList(env?.TOKEN_METER_CLAUDE_CLOUD_HOSTS).filter((host) =>
    /^[a-z0-9.-]+$/i.test(host),
  );
  return [...new Set([...DEFAULT_CLOUD_HOST_SUFFIXES, ...extra])];
}

/** Every identifier form that can refer to the same cloud Session. */
export function cloudSessionIdVariants(sessionId, { prefixes = cloudIdPrefixes() } = {}) {
  const core = cloudSessionIdCore(sessionId);
  if (core == null) return [];
  return prefixes.map((prefix) => `${prefix}${core}`);
}

function hostAllowed(hostname, suffixes) {
  return suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/**
 * The resource URL is the last URL in the key. Split-cache keys prefix it with
 * network-isolation origins (`_dk_https://a https://b https://.../events`).
 */
export function urlFromCacheKey(key) {
  if (typeof key !== "string") return null;
  const tokens = key.split(/\s+/).filter(Boolean);
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const at = tokens[index].search(/https?:\/\//);
    if (at === -1) continue;
    try {
      return new URL(tokens[index].slice(at));
    } catch {
      return null;
    }
  }
  return null;
}

const SENSITIVE_PARAM = /token|key|secret|auth|signature/i;

/** URL path and query with the Session identifier and any tokens redacted. */
export function describeCloudUrl(url, core = null) {
  if (url == null) return null;
  const params = new URLSearchParams(url.search);
  for (const name of [...params.keys()]) {
    if (SENSITIVE_PARAM.test(name)) params.set(name, "<redacted>");
  }
  const query = params.toString();
  let shape = url.pathname + (query ? `?${query}` : "");
  if (core) shape = shape.split(core).join("<id>");
  return shape;
}

/**
 * Classify a cache key relative to one cloud Session.
 * Returns null when the key is unrelated, otherwise
 * `{ kind, url, shape, sessionRef }` where kind is one of
 * `events-page`, `events-stream`, `session-watch`, `session-other`.
 */
export function classifyCloudCacheKey(
  key,
  variants,
  { hostSuffixes = cloudHostSuffixes() } = {},
) {
  const url = urlFromCacheKey(key);
  if (url == null || !hostAllowed(url.hostname, hostSuffixes)) return null;
  const match = /\/code\/sessions\/([^/?#]+)((?:\/[^?#]*)?)/.exec(url.pathname);
  if (match == null) return null;
  const [, segment, rest] = match;
  const core = variants.length > 0 ? cloudSessionIdCore(variants[0]) : null;
  if (segment === "watch") {
    return { kind: "session-watch", url, shape: describeCloudUrl(url, core), sessionRef: null };
  }
  if (!variants.includes(segment)) return null;
  const tail = rest.replace(/\/+$/, "");
  let kind = "session-other";
  if (/^\/events(?:\/stream)$/.test(tail)) kind = "events-stream";
  else if (/^\/events(?:\/[^/]*)?$/.test(tail)) kind = "events-page";
  return { kind, url, shape: describeCloudUrl(url, core), sessionRef: segment };
}

/** Whether a key is worth remembering in the index at all. */
export function isCloudSessionCacheKey(key, { hostSuffixes = cloudHostSuffixes() } = {}) {
  if (typeof key !== "string" || !key.includes("/code/sessions/")) return false;
  const url = urlFromCacheKey(key);
  return url != null && hostAllowed(url.hostname, hostSuffixes);
}

function safeSequence(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && /^\d{1,15}$/.test(value)) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

function sequenceOf(record) {
  return safeSequence(record.sequence_num ?? record.sequenceNum ?? record.seq);
}

function normalizeEvent(record, fallbackSequence) {
  const sequence = sequenceOf(record) ?? fallbackSequence ?? null;
  if (sequence == null) return null;
  const payload = record.payload ?? record.event?.payload ?? null;
  const sessionId = record.session_id ?? record.sessionId ?? record.payload?.session_id ?? null;
  return {
    sequence,
    payload: payload != null && typeof payload === "object" ? payload : null,
    createdAt: record.created_at ?? record.createdAt ?? record.timestamp ?? null,
    sessionId: typeof sessionId === "string" ? sessionId : null,
    source: typeof record.source === "string" ? record.source : null,
  };
}

const CONTAINER_KEYS = ["data", "events", "event", "items", "results", "rows", "history"];

function collect(value, out, depth, fallbackSequence = null) {
  if (value == null || depth > MAX_NESTING) return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  if (sequenceOf(value) != null || (fallbackSequence != null && value.payload != null)) {
    const event = normalizeEvent(value, fallbackSequence);
    if (event) out.push(event);
    return;
  }
  for (const key of CONTAINER_KEYS) {
    if (value[key] != null && typeof value[key] === "object") {
      collect(value[key], out, depth + 1, fallbackSequence);
    }
  }
}

export function extractEventsFromJson(text) {
  const events = [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { events, cursor: null, errors: [`json: ${error.message}`] };
  }
  collect(parsed, events, 0);
  const cursor =
    parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed.next_cursor ?? parsed.nextCursor ?? null
      : null;
  return { events, cursor: cursor == null ? null : String(cursor), errors: [] };
}

/**
 * Parse Server-Sent Events text. The final frame may be incomplete while the
 * stream is still open; it is parsed when its JSON happens to be complete and
 * silently skipped otherwise.
 */
export function extractEventsFromSse(text) {
  const events = [];
  const errors = [];
  let frames = 0;
  let dataLines = [];
  let frameId = null;
  const dispatch = () => {
    if (dataLines.length === 0) {
      dataLines = [];
      frameId = null;
      return;
    }
    frames += 1;
    const data = dataLines.join("\n");
    dataLines = [];
    const fallback = safeSequence(frameId);
    frameId = null;
    const trimmed = data.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      errors.push("sse: incomplete or invalid JSON frame");
      return;
    }
    collect(parsed, events, 0, fallback);
  };
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (rawLine === "") {
      dispatch();
      continue;
    }
    if (rawLine.startsWith(":")) continue; // comment / keepalive
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    else if (field === "id") frameId = value;
  }
  dispatch();
  return { events, frames, errors };
}

/** Detect the body format and extract events from it. */
export function extractCloudEvents(text) {
  const trimmed = text.replace(/^﻿/, "").trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return { format: "json", ...extractEventsFromJson(trimmed) };
  }
  return { format: "sse", cursor: null, ...extractEventsFromSse(text) };
}
