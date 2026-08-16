// Resolves which Codex thread the user is actively working in, without CDP.
//
// The Codex Desktop app runs its own long-lived app-server that owns
// ~/.codex/state_5.sqlite and writes it live. The `threads` table records a
// per-thread `recency_at_ms` stamped when the user submits a turn, plus a
// `thread_source` that separates real user threads from spawned sub-agents.
// Reading that table read-only gives the active user thread — the one that is
// actually consuming tokens — without injecting into or restarting Codex.
//
// This deliberately binds to "the thread that most recently started a turn",
// not "the thread the user is looking at": token flow follows the former, and
// the latter is only recorded in a debounced UI atom that lags disk by minutes.

import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
      row.thread_source === "user" &&
      Number(row.archived) === 0 &&
      typeof row.id === "string" &&
      row.id.length > 0,
  );
  if (eligible.length === 0) return null;
  eligible.sort(
    (left, right) => Number(right.recency_at_ms) - Number(left.recency_at_ms),
  );
  const active = eligible[0];
  return {
    threadId: active.id,
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

// Reads the active user thread from the Codex state database. Fails closed:
// any missing file, locked handle, absent column, or schema drift returns null
// rather than throwing, so a caller never falls back to a wrong thread.
export function readActiveCodexThread(databasePath = defaultStateDatabasePath()) {
  let database = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
      .prepare(
        `SELECT id, name, title, tokens_used, recency_at_ms, thread_source, archived
         FROM threads
         WHERE thread_source = 'user' AND archived = 0
         ORDER BY recency_at_ms DESC
         LIMIT 8`,
      )
      .all();
    return pickActiveThread(rows);
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
