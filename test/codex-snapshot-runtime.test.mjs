import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexSnapshotRuntime } from "../integrations/codex-desktop/src/snapshot-runtime.mjs";

const THREAD_ID = "01a006f3-80e6-76d3-9f5b-c23d709d9d9c";

async function writeRollout(directory, threadId, totalTokens) {
  const filePath = path.join(
    directory,
    `rollout-2026-08-15T12-43-36-${threadId}.jsonl`,
  );
  const lines = [
    {
      timestamp: "2026-08-15T19:43:48.000Z",
      type: "session_meta",
      payload: {
        id: threadId,
        session_id: threadId,
        source: "vscode",
        thread_source: "user",
      },
    },
    {
      timestamp: "2026-08-15T19:43:53.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { total_tokens: totalTokens },
          last_token_usage: { total_tokens: totalTokens },
          model_context_window: 258400,
        },
      },
    },
  ];
  await writeFile(filePath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

test("CodexSnapshotRuntime binds to the active thread and reports its tokens", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeRollout(directory, THREAD_ID, 21019);

  const runtime = new CodexSnapshotRuntime({
    sessionsDirectory: directory,
    resolveActiveThread: () => ({ threadId: THREAD_ID, tokensUsed: 21019 }),
    identity: null,
    usageHistory: null,
    now: () => Date.parse("2026-08-15T19:44:00.000Z"),
  });

  const snapshot = await runtime.snapshot();
  assert.equal(snapshot.status, "bound");
  assert.equal(snapshot.binding.source, "codex-state-db");
  assert.equal(snapshot.binding.exact, true);
  assert.equal(snapshot.binding.threadId, THREAD_ID);
  assert.equal(snapshot.usageMethod, "codex-rollout-raw");
  assert.equal(snapshot.session.totalTokens, 21019);
});

test("CodexSnapshotRuntime returns unbound (exact=false) when no thread is active", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-"));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const runtime = new CodexSnapshotRuntime({
    sessionsDirectory: directory,
    resolveActiveThread: () => null,
    identity: null,
    usageHistory: null,
  });

  const snapshot = await runtime.snapshot();
  assert.equal(snapshot.status, "unbound");
  assert.equal(snapshot.binding.exact, false);
  assert.equal(snapshot.binding.source, "codex-state-db");
});

test("CodexSnapshotRuntime never falls back to a different thread when the active one is absent", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-runtime-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  // A rollout exists on disk, but for a DIFFERENT thread than the active one.
  await writeRollout(directory, "ffffffff-0000-0000-0000-000000000000", 500);

  const runtime = new CodexSnapshotRuntime({
    sessionsDirectory: directory,
    resolveActiveThread: () => ({ threadId: THREAD_ID }),
    identity: null,
    usageHistory: null,
  });

  const snapshot = await runtime.snapshot();
  // Fail closed: the selected thread has no telemetry, so it must not adopt
  // the unrelated rollout's numbers.
  assert.equal(snapshot.status, "unbound");
  assert.equal(snapshot.binding.exact, false);
});
