import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
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
      "integrations/claude-desktop/native/ClaudeAccessibility.swift",
      "integrations/claude-desktop/native/ClaudeModelCatalog.swift",
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

    const root = path.join(directory, "runtime-root");
    const claudeApp = path.join(directory, "Claude.app");
    const stateDirectory = path.join(directory, "state");
    const requiredFiles = [
      path.join(root, "src", "cli.mjs"),
      path.join(root, "runtime", "token-meter-ui.js"),
      path.join(root, "runtime", "token-meter-ui.css"),
      path.join(
        root,
        "integrations",
        "claude-desktop",
        "src",
        "overlay-bridge.mjs",
      ),
      path.join(claudeApp, "Contents", "Resources", "app.asar"),
    ];
    await Promise.all(
      requiredFiles.map(async (file) => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "fixture");
      }),
    );

    const child = spawn(
      executable,
      [
        "--root",
        root,
        "--node",
        process.execPath,
        "--claude-app",
        claudeApp,
        "--state-dir",
        stateDirectory,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TOKEN_METER_FORCE_ACCESSIBILITY_DENIED: "1" },
      },
    );
    context.after(() => {
      if (child.exitCode == null) child.kill("SIGTERM");
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    await delay(4_200);
    assert.equal(child.exitCode, null, `companion exited early: ${stderr}`);
    assert.equal((stderr.match(/Waiting quietly for permission/g) ?? []).length, 1);
    assert.doesNotMatch(stderr, /prompt-accessibility/);
    child.kill("SIGTERM");
    await once(child, "exit");
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
