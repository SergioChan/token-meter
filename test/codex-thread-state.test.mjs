import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  pickActiveThread,
  readActiveCodexThread,
} from "../integrations/codex-desktop/src/thread-state.mjs";

test("pickActiveThread resolves the most recent sub-agent to its root session", () => {
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
      session_id: "bbbbbbbb-0000-0000-0000-000000000000",
      archived: 0,
    },
  ]);
  assert.equal(active.threadId, "bbbbbbbb-0000-0000-0000-000000000000");
  assert.equal(active.activityThreadId, "cccccccc-0000-0000-0000-000000000000");
  assert.equal(active.activityThreadSource, "subagent");
  assert.equal(active.title, "guardian child");
  assert.equal(active.tokensUsed, 4242);
  assert.equal(active.recencyAtMs, 9000);
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
      rollout_path TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    )`);
    const insert = db.prepare(
      `INSERT INTO threads (id, name, title, tokens_used, recency_at_ms, thread_source, rollout_path, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("old", "old user", "old user", 10, 1000, "user", null, 0);
    insert.run("current", "token-meter", "token-meter", 25712557, 9000, "user", null, 0);
    const childRollout = path.join(dir, "child.jsonl");
    await writeFile(
      childRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "child", session_id: "current" } })}\n`,
    );
    insert.run("child", "sub", "sub", 5000, 9999, "subagent", childRollout, 0);
    db.close();

    const active = readActiveCodexThread(dbPath);
    assert.equal(active.threadId, "current");
    assert.equal(active.activityThreadId, "child");
    assert.equal(active.activityThreadSource, "subagent");
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
