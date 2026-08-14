import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeClaudeProjectDirectory } from "../integrations/claude-desktop/src/transcript-store.mjs";

const desktopSessionId = "local_00000000-0000-4000-8000-000000000201";
const cliSessionId = "00000000-0000-4000-8000-000000000202";
const cwd = "/private/claude-bridge-fixture";

test("Claude overlay bridge serves multiple snapshots in one process", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-meter-claude-bridge-"));
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
    JSON.stringify({ sessionId: desktopSessionId, cliSessionId, cwd }),
  );
  await writeFile(
    path.join(projectDirectory, `${cliSessionId}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      timestamp: 1_000,
      requestId: "request-1",
      message: {
        id: "response-1",
        role: "assistant",
        stop_reason: "end_turn",
        content: [],
        usage: { input_tokens: 7, output_tokens: 3 },
      },
    })}\n`,
  );

  const child = spawn(
    process.execPath,
    [
      "integrations/claude-desktop/src/overlay-bridge.mjs",
      "--sessions-dir",
      sessionsDirectory,
      "--projects-dir",
      projectsDirectory,
    ],
    { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(
    `${JSON.stringify({ requestId: 1, desktopSessionId })}\n` +
      `${JSON.stringify({ requestId: 2, desktopSessionId: "invalid" })}\n`,
  );
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  assert.equal(exitCode, 0, stderr);
  const responses = stdout.trim().split("\n").map(JSON.parse);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].requestId, 1);
  assert.equal(responses[0].snapshot.status, "bound");
  assert.equal(responses[0].snapshot.session.totalTokens, 10);
  assert.equal(responses[1].requestId, 2);
  assert.equal(responses[1].snapshot.status, "unbound");
});

test("Claude overlay bridge asks the registry for a signed browser pairing URL", async () => {
  const source = await readFile(
    "integrations/claude-desktop/src/overlay-bridge.mjs",
    "utf8",
  );
  assert.match(source, /request\?\.command === "leaderboard-url"/);
  assert.match(source, /await syncCommunity\("leaderboard"\)/);
  assert.match(source, /await createLeaderboardUrl\(identity\)/);
});
