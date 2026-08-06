import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test(
  "Claude native overlay exposes a stable command interface",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "token-meter-claude-native-"),
    );
    context.after(() => rm(directory, { recursive: true, force: true }));
    const executable = path.join(directory, "TokenMeterClaudeOverlay");
    await execFileAsync("/usr/bin/swiftc", [
      "integrations/claude-desktop/native/TokenMeterClaudeOverlay.swift",
      "-o",
      executable,
      "-framework",
      "AppKit",
      "-framework",
      "ApplicationServices",
      "-framework",
      "WebKit",
    ]);

    const { stdout } = await execFileAsync(executable, ["--help"]);
    assert.match(stdout, /--root PATH/);
    assert.match(stdout, /--node PATH/);
    assert.match(stdout, /--check-accessibility/);
    await assert.rejects(execFileAsync(executable), /--root is required/);
  },
);

test("Claude companion waits quietly for Accessibility and passes valid bridge arguments", async () => {
  const source = await readFile(
    "integrations/claude-desktop/native/TokenMeterClaudeOverlay.swift",
    "utf8",
  );
  const runBranch = source.match(
    /case \.run\(let configuration\):([\s\S]+?)\n\s*}\n} catch/,
  )?.[1];

  assert.ok(runBranch, "normal run branch must remain inspectable");
  assert.match(source, /private final class CompanionRuntime/);
  assert.match(source, /Waiting quietly for permission/);
  assert.doesNotMatch(runBranch, /guard AXIsProcessTrusted\(\)/);
  assert.doesNotMatch(source, /"--sessions-dir",\s*"--sessions-dir"/);
  assert.match(
    source,
    /"--sessions-dir",\s*configuration\.sessionsDirectoryURL\.path/,
  );
});
