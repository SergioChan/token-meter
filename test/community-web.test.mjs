import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function inlineScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );
}

test("community leaderboard uses live data and passwordless browser pairing", async () => {
  const html = await readFile("web/leaderboard.html", "utf8");
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(html, /const SAMPLE\b/);
  assert.match(html, /\/api\/v1\/browser-sessions/);
  assert.match(html, /\/api\/v1\/me/);
  assert.match(html, /entry\.rowId === viewer\?\.rowId/);
  assert.match(html, /You’re #\$\{viewer\.rank\} in the past 7 days/);
  assert.match(html, /row\.sessionWindowDays === 7/);
  assert.match(html, /viewer\.sessionWindowDays === 7/);
  assert.match(html, /7-day sessions pending/);
  assert.match(html, /<span class="you-badge">you<\/span>/);
  assert.doesNotThrow(() => new Function(scripts[0]));
});

test("local dashboard requests a pairing URL and validates the public host", async () => {
  const html = await readFile("web/dashboard.html", "utf8");
  const scripts = inlineScripts(html);
  assert.match(html, /\/api\/leaderboard-pairing/);
  assert.match(html, /target\.protocol !== "https:"/);
  assert.match(html, /target\.hostname !== "www\.tokenwidget\.app"/);
  assert.match(html, /target\.pathname !== "\/leaderboard"/);
  assert.match(html, /target\.hash\.startsWith\("#pair="\)/);
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
});
