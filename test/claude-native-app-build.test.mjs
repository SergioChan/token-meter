import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test(
  "Claude native app builder produces a signed background application",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "token-meter-claude-app-"),
    );
    context.after(() => rm(directory, { recursive: true, force: true }));
    const output = path.join(directory, "Token Meter for Claude.app");
    const builder = "integrations/claude-desktop/scripts/build-app.sh";
    await chmod(builder, 0o755);
    await execFileAsync(builder, ["--output", output]);

    const { stdout: bundleId } = await execFileAsync("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleIdentifier",
      path.join(output, "Contents", "Info.plist"),
    ]);
    assert.equal(bundleId.trim(), "com.sergiochan.token-meter.claude-overlay");
    await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", output]);
    const executable = path.join(
      output,
      "Contents",
      "MacOS",
      "TokenMeterClaudeOverlay",
    );
    const { stdout: help } = await execFileAsync(executable, ["--help"]);
    assert.match(help, /--prompt-accessibility/);
  },
);

test(
  "Claude native app builder can embed its runtime and Node.js",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "token-meter-claude-self-contained-"),
    );
    context.after(() => rm(directory, { recursive: true, force: true }));
    const output = path.join(directory, "Token Meter for Claude.app");
    await execFileAsync("integrations/claude-desktop/scripts/build-app.sh", [
      "--output",
      output,
      "--embed-runtime-root",
      process.cwd(),
      "--embed-node-root",
      path.dirname(path.dirname(process.execPath)),
      "--version",
      "0.2.0",
      "--build-number",
      "2",
    ]);

    const resources = path.join(output, "Contents", "Resources");
    await Promise.all([
      access(path.join(resources, "Node", "bin", "node")),
      access(path.join(resources, "Node", "LICENSE")),
      access(path.join(resources, "TokenMeterRuntime", "src", "cli.mjs")),
      access(
        path.join(
          resources,
          "TokenMeterRuntime",
          "integrations",
          "claude-desktop",
          "src",
          "overlay-bridge.mjs",
        ),
      ),
    ]);
    const { stdout: nodeVersion } = await execFileAsync(
      path.join(resources, "Node", "bin", "node"),
      ["--version"],
    );
    assert.match(nodeVersion, /^v\d+/);
    const { stdout: version } = await execFileAsync("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleShortVersionString",
      path.join(output, "Contents", "Info.plist"),
    ]);
    assert.equal(version.trim(), "0.2.0");
    await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", output]);
  },
);
