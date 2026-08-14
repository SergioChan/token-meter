import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageHistory } from "../src/core/usage-history.mjs";

const NOW = Date.parse("2026-08-13T10:00:00");

function writeFixtures() {
  const root = mkdtempSync(join(tmpdir(), "token-meter-usage-"));
  const claudeDir = join(root, "claude", "proj-a");
  const codexDir = join(root, "codex", "2026", "08");
  const clineDir = join(root, "cline", "task-1");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(clineDir, { recursive: true });

  const claudeLine = (ts, usage, extra = {}) =>
    JSON.stringify({ type: "assistant", timestamp: ts, isSidechain: false, message: { usage }, ...extra });
  writeFileSync(
    join(claudeDir, "session-1.jsonl"),
    [
      claudeLine("2026-08-12T09:00:00Z", {
        input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 30, cache_read_input_tokens: 820,
      }),
      claudeLine("2026-08-13T09:30:00Z", {
        input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 700,
      }),
      "not-json",
    ].join("\n"),
  );
  // Sidechain-only file: tokens count, session does not.
  writeFileSync(
    join(claudeDir, "agent-1.jsonl"),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-13T09:40:00Z", isSidechain: true, message: { usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
  );

  writeFileSync(
    join(codexDir, "rollout-1.jsonl"),
    [
      JSON.stringify({ timestamp: "2026-08-13T22:10:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 200, total_tokens: 1200 } } } }),
    ].join("\n"),
  );

  writeFileSync(
    join(clineDir, "ui_messages.json"),
    JSON.stringify([
      { say: "api_req_started", ts: Date.parse("2026-08-11T14:00:00Z"), text: JSON.stringify({ tokensIn: 40, tokensOut: 20, cacheWrites: 5, cacheReads: 35 }) },
      { say: "text", ts: 1, text: "ignore me" },
    ]),
  );

  return {
    root,
    history: new UsageHistory({
      claudeProjectsDir: join(root, "claude"),
      codexSessionsDir: join(root, "codex"),
      clineTaskDirs: [join(root, "cline", "..", "cline")],
      cacheFile: join(root, "cache.json"),
      now: () => NOW,
    }),
  };
}

test("aggregates daily buckets, platforms, and stats across all sources", () => {
  const { history } = writeFixtures();
  const result = history.collect();

  assert.equal(result.stats.lifetimeTokens, 1000 + 1000 + 15 + 1200 + 100);
  assert.equal(result.byPlatform.claudeCode.tokens, 2015);
  assert.equal(result.byPlatform.codex.tokens, 1200);
  assert.equal(result.byPlatform.cline.tokens, 100);
  // Sidechain file counts tokens but not sessions.
  assert.equal(result.byPlatform.claudeCode.sessions, 1);
  assert.equal(result.stats.sessionCount, 3);
  assert.equal(result.stats.daysActive, 3);
  assert.equal(result.stats.cacheReadShare > 0.5, true);
  assert.equal(result.stats.topDays[0].tokens >= result.stats.topDays.at(-1).tokens, true);
  const day13 = result.days.find((d) => d.date === "2026-08-13");
  assert.ok(day13.byPlatform.claudeCode > 0);
});

test("cache short-circuits unchanged files and invalidates on change", () => {
  const { history, root } = writeFixtures();
  const first = history.collect();
  assert.equal(first.parsedFiles, 4);
  const second = history.collect();
  assert.equal(second.parsedFiles, 0);
  assert.equal(second.stats.lifetimeTokens, first.stats.lifetimeTokens);

  const cache = JSON.parse(readFileSync(join(root, "cache.json"), "utf8"));
  assert.equal(cache.version, 1);

  writeFileSync(
    join(root, "claude", "proj-a", "session-1.jsonl"),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-13T09:00:00Z", isSidechain: false, message: { usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
  );
  const third = history.collect();
  assert.equal(third.parsedFiles, 1);
  assert.equal(third.stats.lifetimeTokens, 2 + 15 + 1200 + 100);
});

test("streaks count consecutive active days ending now", () => {
  const { history } = writeFixtures();
  const result = history.collect();
  // Active days: 8/11 (cline), 8/12, 8/13 → 3-day streak ending today (NOW = 8/13).
  assert.equal(result.stats.currentStreakDays, 3);
  assert.equal(result.stats.longestStreakDays, 3);
});
