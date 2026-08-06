import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudeSnapshotRuntime } from "../integrations/claude-desktop/src/snapshot-runtime.mjs";
import { encodeClaudeProjectDirectory } from "../integrations/claude-desktop/src/transcript-store.mjs";

const desktopSessionId = "local_00000000-0000-4000-8000-000000000101";
const cliSessionId = "00000000-0000-4000-8000-000000000102";
const cwd = "/private/claude-runtime-fixture";

test("Claude snapshot runtime follows one exact Desktop Session", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-meter-claude-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sessionsDirectory = path.join(root, "sessions");
  const projectsDirectory = path.join(root, "projects");
  const metadataDirectory = path.join(sessionsDirectory, "account", "organization");
  const projectDirectory = path.join(
    projectsDirectory,
    encodeClaudeProjectDirectory(cwd),
  );
  await Promise.all([
    mkdir(metadataDirectory, { recursive: true }),
    mkdir(projectDirectory, { recursive: true }),
  ]);
  await writeFile(
    path.join(metadataDirectory, `${desktopSessionId}.json`),
    JSON.stringify({
      sessionId: desktopSessionId,
      cliSessionId,
      cwd,
      createdAt: 100,
      lastActivityAt: 200,
      lastFocusedAt: 300,
      model: "claude-test",
    }),
  );
  await writeFile(
    path.join(projectDirectory, `${cliSessionId}.jsonl`),
    `${JSON.stringify({
      type: "user",
      timestamp: 1_000,
      message: { role: "user", content: "discarded prompt" },
    })}\n${JSON.stringify({
      type: "assistant",
      timestamp: 2_000,
      requestId: "request-1",
      message: {
        id: "response-1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "discarded response" }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 40,
        },
      },
    })}\n`,
  );

  const runtime = new ClaudeSnapshotRuntime({
    sessionsDirectory,
    projectsDirectory,
    now: () => 3_000,
  });
  const snapshot = await runtime.snapshot(desktopSessionId);

  assert.equal(snapshot.status, "bound");
  assert.equal(snapshot.sessionId, desktopSessionId);
  assert.equal(snapshot.session.totalTokens, 100);
  assert.equal(snapshot.context.tokens, 60);
  assert.deepEqual(snapshot.binding, {
    source: "claude-desktop-session-metadata",
    exact: true,
    desktopSessionId,
    cliSessionId,
  });
  assert.equal(snapshot.usageMethod, "claude-transcript-raw");
  assert.equal(JSON.stringify(snapshot).includes("discarded"), false);

  const unbound = await runtime.snapshot("local_not-a-session");
  assert.equal(unbound.status, "unbound");
  assert.equal(unbound.reason, "invalid-desktop-session-id");
});
