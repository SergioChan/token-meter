import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCloudCacheKey,
  cloudIdPrefixes,
  cloudSessionIdVariants,
  describeCloudUrl,
  extractCloudEvents,
  extractEventsFromSse,
  isCloudSessionCacheKey,
} from "../integrations/claude-desktop/src/cloud-events.mjs";

const core = "01HWYa9x7ncCBzndDSGPH4VM";
const variants = cloudSessionIdVariants(`session_${core}`);

test("one cloud Session is recognized under every identifier prefix", () => {
  assert.deepEqual(variants, [`session_${core}`, `cse_${core}`]);
  assert.deepEqual(cloudSessionIdVariants(`cse_${core}`), variants);
  assert.deepEqual(cloudSessionIdVariants("local_00000000-0000-4000-8000-000000000101"), []);
  assert.deepEqual(
    cloudIdPrefixes({ TOKEN_METER_CLAUDE_CLOUD_ID_PREFIXES: "ccs_, bad prefix,cse_" }),
    ["session_", "cse_", "ccs_"],
  );
});

// Every request shape observed on a production Claude Desktop install between
// 2026-07 and 2026-09. The store must recognize all of them without any
// knowledge of limit, sort order, or cursor style.
const observed = [
  ["events-page", `https://claude.ai/v1/code/sessions/session_${core}/events?limit=50&sort_order=desc`],
  ["events-page", `https://claude.ai/v1/code/sessions/session_${core}/events?limit=200&sort_order=desc`],
  ["events-page", `https://claude.ai/v1/code/sessions/session_${core}/events?limit=500&sort_order=asc&cursor=1000`],
  ["events-page", `https://claude.ai/v1/code/sessions/session_${core}/events?limit=500&sort_order=desc&cursor=86`],
  ["events-page", `https://claude.ai/v1/code/sessions/cse_${core}/events?limit=100`],
  ["events-page", `https://claude.ai/v1/code/sessions/cse_${core}/events?limit=500&cursor=1769`],
  ["events-stream", `https://claude.ai/v1/code/sessions/cse_${core}/events/stream?from_sequence_num=146`],
  ["session-watch", "https://claude.ai/v1/code/sessions/watch?exclude_tags=-&resume_token=MTc4%3D%3D"],
];

test("every observed Claude Desktop request shape is classified", () => {
  for (const [kind, url] of observed) {
    const info = classifyCloudCacheKey(`1/0/${url}`, variants);
    assert.equal(info?.kind, kind, url);
    assert.equal(info.shape.includes(core), false, "identifier is redacted in the shape");
    assert.equal(isCloudSessionCacheKey(`1/0/${url}`), true);
  }
  assert.equal(
    describeCloudUrl(new URL(observed.at(-1)[1])),
    "/v1/code/sessions/watch?exclude_tags=-&resume_token=%3Credacted%3E",
  );
});

test("unrelated, foreign-host, and other-Session keys are rejected", () => {
  assert.equal(classifyCloudCacheKey(`1/0/https://claude.ai/v1/code/sessions/session_${core}/share`, variants)?.kind, "session-other");
  assert.equal(classifyCloudCacheKey(`1/0/https://claude.ai/v1/code/sessions/session_${core}`, variants)?.kind, "session-other");
  assert.equal(classifyCloudCacheKey(`1/0/https://evil.example/v1/code/sessions/session_${core}/events`, variants), null);
  assert.equal(classifyCloudCacheKey(`1/0/https://claude.ai/v1/code/sessions/session_${core.replace("01", "02")}/events`, variants), null);
  assert.equal(classifyCloudCacheKey("1/0/https://claude.ai/api/organizations", variants), null);
  assert.equal(isCloudSessionCacheKey("1/0/https://claude.ai/api/organizations"), false);
  // Split-cache keys carry a network isolation prefix before the URL.
  assert.equal(
    classifyCloudCacheKey(`1/0/_dk_https://claude.ai https://claude.ai https://claude.ai/v1/code/sessions/cse_${core}/events?limit=100`, variants)?.kind,
    "events-page",
  );
});

test("JSON pages yield events whether or not rows carry payloads", () => {
  const page = JSON.stringify({
    data: [
      { sequence_num: "4", created_at: "2026-09-20T00:00:04Z", payload: { type: "user" } },
      { sequence_num: 3, created_at: "2026-09-20T00:00:03Z", payload: null },
      { sequence_num: "2", payload: { type: "assistant" }, session_id: `cse_${core}` },
      { bogus: true },
    ],
    next_cursor: "2",
  });
  const result = extractCloudEvents(page);
  assert.equal(result.format, "json");
  assert.deepEqual(result.events.map((event) => event.sequence), [4, 3, 2]);
  assert.equal(result.events[1].payload, null);
  assert.equal(result.events[2].sessionId, `cse_${core}`);
  assert.equal(result.cursor, "2");
});

test("wrapped JSON shapes are still harvested", () => {
  const wrapped = JSON.stringify({ events: [{ event: { sequence_num: 7, payload: { type: "user" } } }, { sequence_num: 8, payload: { type: "user" } }] });
  assert.deepEqual(extractCloudEvents(wrapped).events.map((event) => event.sequence), [7, 8]);
  assert.deepEqual(extractCloudEvents("[{\"sequence_num\":1,\"payload\":{}}]").events.map((event) => event.sequence), [1]);
});

test("SSE streams yield events, tolerate keepalives, and skip an unfinished frame", () => {
  const stream = [
    ": keepalive",
    "",
    "id: 146",
    "event: message",
    "data: {\"sequence_num\": 146, \"payload\": {\"type\": \"user\"}}",
    "",
    "id: 147",
    "data: {\"payload\": {\"type\": \"assistant\"},",
    "data:  \"created_at\": \"2026-09-20T00:00:00Z\"}",
    "",
    ": keepalive",
    "",
    "data: {\"sequence_num\": 148, \"payload\": {\"ty",
  ].join("\n");
  const result = extractEventsFromSse(stream);
  assert.deepEqual(result.events.map((event) => event.sequence), [146, 147]);
  assert.equal(result.events[1].createdAt, "2026-09-20T00:00:00Z");
  assert.equal(result.errors.length, 1);
  assert.equal(extractCloudEvents(stream).format, "sse");
  assert.equal(extractCloudEvents("\r\n" + stream.replaceAll("\n", "\r\n")).events.length, 2);
});
