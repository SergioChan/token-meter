import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("Claude LaunchAgent starts only the native companion", async (context) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "token-meter-claude-agent-"),
  );
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "claude-meter.plist");
  const root = path.join(directory, "Token & Meter");
  const app = path.join(root, "Token Meter for Claude.app");

  await execFileAsync(process.execPath, [
    "integrations/claude-desktop/scripts/render-launch-agent.mjs",
    "--output",
    output,
    "--label",
    "com.sergiochan.token-meter.claude-desktop",
    "--executable",
    path.join(app, "Contents", "MacOS", "TokenMeterClaudeOverlay"),
    "--root",
    root,
    "--node",
    "/opt/homebrew/bin/node",
    "--claude-app",
    "/Applications/Claude.app",
    "--state-dir",
    path.join(directory, "State & Position"),
    "--stdout",
    path.join(directory, "out.log"),
    "--stderr",
    path.join(directory, "error.log"),
  ]);

  const source = await readFile(output, "utf8");
  assert.match(source, /Token &amp; Meter/);
  assert.match(source, /State &amp; Position/);
  assert.match(source, /<key>KeepAlive<\/key>\s*<dict>/);
  assert.match(source, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.doesNotMatch(source, /osascript|remote-debugging|tell application|Claude.*quit/i);
  if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/plutil", ["-lint", output]);
  }
});

test("Claude readiness requires an exact executable command boundary", async () => {
  const helper = "integrations/claude-desktop/scripts/process-identity.sh";
  const executable = "/Applications/Token Meter for Claude.app/Contents/MacOS/Overlay";
  await execFileAsync("/bin/bash", [
    "-c",
    'source "$1"; token_meter_command_matches_executable "$2 --root /tmp" "$2"',
    "bash",
    helper,
    executable,
  ]);
  await assert.rejects(
    execFileAsync("/bin/bash", [
      "-c",
      'source "$1"; token_meter_command_matches_executable "$2.evil --root /tmp" "$2"',
      "bash",
      helper,
      executable,
    ]),
  );
});
