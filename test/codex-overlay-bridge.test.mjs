import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const THREAD_ID = "01a006f3-80e6-76d3-9f5b-c23d709d9d9c";

async function writeRollout(directory, threadId, totalTokens) {
  await writeFile(
    path.join(directory, `rollout-2026-08-15T12-43-36-${threadId}.jsonl`),
    [
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
          info: { total_token_usage: { total_tokens: totalTokens } },
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n",
  );
}

function writeStateDb(dbPath, activeThreadId) {
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, name TEXT, title TEXT NOT NULL DEFAULT '',
    tokens_used INTEGER NOT NULL DEFAULT 0, recency_at_ms INTEGER NOT NULL DEFAULT 0,
    thread_source TEXT, archived INTEGER NOT NULL DEFAULT 0)`);
  db.prepare(
    `INSERT INTO threads (id, name, tokens_used, recency_at_ms, thread_source, archived)
     VALUES (?, ?, ?, ?, 'user', 0)`,
  ).run(activeThreadId, "token-meter", 21019, 9000);
  db.close();
}

test("overlay bridge serves a bound Codex snapshot from the state DB", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-meter-codex-bridge-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const codexSessions = path.join(root, "codex-sessions");
  const claudeSessions = path.join(root, "claude-sessions");
  const claudeProjects = path.join(root, "claude-projects");
  const stateDb = path.join(root, "state_5.sqlite");
  await Promise.all([
    mkdir(codexSessions, { recursive: true }),
    mkdir(claudeSessions, { recursive: true }),
    mkdir(claudeProjects, { recursive: true }),
  ]);
  await writeRollout(codexSessions, THREAD_ID, 21019);
  writeStateDb(stateDb, THREAD_ID);

  const child = spawn(
    process.execPath,
    [
      "integrations/claude-desktop/src/overlay-bridge.mjs",
      "--sessions-dir",
      claudeSessions,
      "--projects-dir",
      claudeProjects,
      "--codex-sessions-dir",
      codexSessions,
      "--codex-state-db",
      stateDb,
    ],
    {
      cwd: path.resolve("."),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: root, TOKEN_METER_REGISTRY_URL: "" },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(`${JSON.stringify({ requestId: 1, command: "codex-snapshot" })}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0, stderr);
  // The SQLite experimental warning must be filtered out of the log stream.
  assert.doesNotMatch(stderr, /ExperimentalWarning.*SQLite/i);
  const responses = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses[0].requestId, 1);
  assert.equal(responses[0].snapshot.status, "bound");
  assert.equal(responses[0].snapshot.binding.source, "codex-state-db");
  assert.equal(responses[0].snapshot.binding.exact, true);
  assert.equal(responses[0].snapshot.binding.threadId, THREAD_ID);
  assert.equal(responses[0].snapshot.session.totalTokens, 21019);
});
