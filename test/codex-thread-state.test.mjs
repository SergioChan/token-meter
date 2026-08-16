import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  pickActiveThread,
  readActiveCodexThread,
} from "../integrations/codex-desktop/src/thread-state.mjs";

test("pickActiveThread selects the most recent user thread and drops sub-agents", () => {
  const active = pickActiveThread([
    {
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      name: "gmail triage",
      title: "gmail triage",
      tokens_used: 100,
      recency_at_ms: 1000,
      thread_source: "user",
      archived: 0,
    },
    {
      id: "bbbbbbbb-0000-0000-0000-000000000000",
      name: "token-meter",
      title: "token-meter",
      tokens_used: 999,
      recency_at_ms: 5000,
      thread_source: "user",
      archived: 0,
    },
    {
      id: "cccccccc-0000-0000-0000-000000000000",
      name: "guardian child",
      title: "guardian child",
      tokens_used: 4242,
      recency_at_ms: 9000,
      thread_source: "subagent",
      archived: 0,
    },
  ]);
  assert.equal(active.threadId, "bbbbbbbb-0000-0000-0000-000000000000");
  assert.equal(active.title, "token-meter");
  assert.equal(active.tokensUsed, 999);
  assert.equal(active.recencyAtMs, 5000);
});

test("pickActiveThread ignores archived threads and returns null when none remain", () => {
  assert.equal(
    pickActiveThread([
      {
        id: "aaaaaaaa-0000-0000-0000-000000000000",
        name: "archived",
        title: "archived",
        tokens_used: 5,
        recency_at_ms: 8000,
        thread_source: "user",
        archived: 1,
      },
    ]),
    null,
  );
  assert.equal(pickActiveThread([]), null);
  assert.equal(pickActiveThread(null), null);
});

test("pickActiveThread falls back to title when name is empty", () => {
  const active = pickActiveThread([
    {
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      name: "",
      title: "derived from first message",
      tokens_used: 0,
      recency_at_ms: 1,
      thread_source: "user",
      archived: 0,
    },
  ]);
  assert.equal(active.title, "derived from first message");
});

test("readActiveCodexThread reads the active thread from a live-shaped database", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-state-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      name TEXT,
      title TEXT NOT NULL DEFAULT '',
      tokens_used INTEGER NOT NULL DEFAULT 0,
      recency_at_ms INTEGER NOT NULL DEFAULT 0,
      thread_source TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    )`);
    const insert = db.prepare(
      `INSERT INTO threads (id, name, title, tokens_used, recency_at_ms, thread_source, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("old", "old user", "old user", 10, 1000, "user", 0);
    insert.run("current", "token-meter", "token-meter", 25712557, 9000, "user", 0);
    insert.run("child", "sub", "sub", 5000, 9999, "subagent", 0);
    db.close();

    const active = readActiveCodexThread(dbPath);
    assert.equal(active.threadId, "current");
    assert.equal(active.tokensUsed, 25712557);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readActiveCodexThread fails closed to null on a missing database", () => {
  assert.equal(
    readActiveCodexThread("/nonexistent/path/state_5.sqlite"),
    null,
  );
});
