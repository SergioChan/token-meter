// Resolves which Codex thread the user is actively working in, without CDP.
//
// The Codex Desktop app runs its own long-lived app-server that owns
// ~/.codex/state_5.sqlite and writes it live. The `threads` table records a
// per-thread `recency_at_ms` stamped when the user submits a turn, plus a
// `thread_source` that separates real user threads from spawned sub-agents.
// Reading that table read-only gives the most recently active user or sub-Agent
// thread — the one actually consuming tokens — without injecting into or
// restarting Codex. Sub-Agent metadata resolves back to its root Session.
//
// This deliberately binds to "the thread that most recently started a turn",
// not "the thread the user is looking at": token flow follows the former, and
// the latter is only recorded in a debounced UI atom that lags disk by minutes.

import os from "node:os";
import path from "node:path";
import { closeSync, openSync, readSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const META_READ_LIMIT = 256 * 1024;

export function defaultStateDatabasePath() {
  return path.join(os.homedir(), ".codex", "state_5.sqlite");
}

// Pure selection over already-read rows, split out so the ranking rule can be
// tested without a database. Rows mirror the `threads` columns we select.
export function pickActiveThread(rows) {
  if (!Array.isArray(rows)) return null;
  const eligible = rows.filter(
    (row) =>
      row != null &&
      (row.thread_source === "user" ||
        (row.thread_source === "subagent" && typeof row.session_id === "string")) &&
      Number(row.archived) === 0 &&
      typeof row.id === "string" &&
      row.id.length > 0,
  );
  if (eligible.length === 0) return null;
  eligible.sort(
    (left, right) => Number(right.recency_at_ms) - Number(left.recency_at_ms),
  );
  const active = eligible[0];
  const rootThreadId =
    active.thread_source === "subagent" ? active.session_id : active.id;
  return {
    threadId: rootThreadId,
    activityThreadId: active.id,
    activityThreadSource: active.thread_source,
    title: typeof active.name === "string" && active.name.length > 0
      ? active.name
      : typeof active.title === "string"
        ? active.title
        : null,
    tokensUsed: Number.isFinite(Number(active.tokens_used))
      ? Number(active.tokens_used)
      : null,
    recencyAtMs: Number.isFinite(Number(active.recency_at_ms))
      ? Number(active.recency_at_ms)
      : null,
  };
}

function readRolloutSessionId(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  let descriptor = null;
  try {
    descriptor = openSync(filePath, "r");
    const buffer = Buffer.allocUnsafe(META_READ_LIMIT);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 0) return null;
    const value = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    const sessionId = value?.type === "session_meta" ? value.payload?.session_id : null;
    return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
  } catch {
    return null;
  } finally {
    if (descriptor != null) {
      try { closeSync(descriptor); } catch { /* best-effort read-only close */ }
    }
  }
}

// Reads the active turn candidate from the Codex state database. Fails closed:
// any missing file, locked handle, absent column, or schema drift returns null
// rather than throwing, so a caller never falls back to a wrong thread.
export function readActiveCodexThread(databasePath = defaultStateDatabasePath()) {
  let database = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
      .prepare(
        `SELECT id, name, title, tokens_used, recency_at_ms, thread_source, archived,
                rollout_path
         FROM threads
         WHERE thread_source IN ('user', 'subagent') AND archived = 0
         ORDER BY recency_at_ms DESC
         LIMIT 8`,
      )
      .all();
    const candidates = rows.map((row) => ({
      ...row,
      session_id:
        row.thread_source === "subagent"
          ? readRolloutSessionId(row.rollout_path)
          : row.id,
    }));
    return pickActiveThread(candidates);
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } catch {
      // A close failure on a read-only handle is not actionable.
    }
  }
}
