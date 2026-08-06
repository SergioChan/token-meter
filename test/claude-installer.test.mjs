import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test(
  "Claude installer builds an isolated companion without loading it",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "token-meter-claude-install-"),
    );
    context.after(() => rm(directory, { recursive: true, force: true }));
    const installRoot = path.join(directory, "Application Support", "Claude Meter");
    const stateDirectory = path.join(directory, "Application Support", "State");
    const launchAgentsDirectory = path.join(directory, "LaunchAgents");
    const logDirectory = path.join(directory, "Logs");
    const claudeApp = path.join(directory, "Claude.app");
    const verifier = path.join(directory, "verify-claude.sh");
    const launchctl = path.join(directory, "launchctl");
    const claudeExecutable = path.join(claudeApp, "Contents", "MacOS", "Claude");
    await Promise.all([
      mkdir(path.dirname(claudeExecutable), { recursive: true }),
      mkdir(path.join(claudeApp, "Contents", "Resources"), { recursive: true }),
    ]);
    await writeFile(claudeExecutable, "#!/bin/bash\nexit 0\n");
    await writeFile(path.join(claudeApp, "Contents", "Resources", "app.asar"), "fixture");
    await chmod(claudeExecutable, 0o755);
    await writeFile(
      verifier,
      `#!/bin/bash\nprintf '%s\\n' ${JSON.stringify(claudeExecutable)}\n`,
    );
    await chmod(verifier, 0o755);
    await writeFile(launchctl, "#!/bin/bash\nexit 1\n");
    await chmod(launchctl, 0o755);
    const nodePath = existsSync("/opt/homebrew/bin/node")
      ? "/opt/homebrew/bin/node"
      : process.execPath;

    await execFileAsync(
      "/bin/bash",
      [
        "integrations/claude-desktop/scripts/install.sh",
        "--node",
        nodePath,
        "--claude-app",
        claudeApp,
        "--no-load",
        "--no-prompt",
      ],
      {
        env: {
          ...process.env,
          TOKEN_METER_CLAUDE_VERIFIER: verifier,
          TOKEN_METER_CLAUDE_INSTALL_ROOT: installRoot,
          TOKEN_METER_CLAUDE_STATE_DIR: stateDirectory,
          TOKEN_METER_LAUNCH_AGENTS_DIR: launchAgentsDirectory,
          TOKEN_METER_CLAUDE_LOG_DIR: logDirectory,
          TOKEN_METER_LAUNCHCTL: launchctl,
        },
      },
    );

    const app = path.join(installRoot, "Token Meter for Claude.app");
    await Promise.all([
      access(path.join(app, "Contents", "MacOS", "TokenMeterClaudeOverlay")),
      access(path.join(installRoot, "src", "cli.mjs")),
      access(
        path.join(
          installRoot,
          "integrations",
          "claude-desktop",
          "src",
          "overlay-bridge.mjs",
        ),
      ),
    ]);
    const plist = await readFile(
      path.join(
        launchAgentsDirectory,
        "com.sergiochan.token-meter.claude-desktop.plist",
      ),
      "utf8",
    );
    assert.match(plist, /Token Meter for Claude\.app/);
    assert.match(plist, new RegExp(nodePath.replaceAll("/", "\\/")));
    assert.equal(existsSync(stateDirectory), true);

    const { stdout: statusOutput } = await execFileAsync(
      "/bin/bash",
      ["integrations/claude-desktop/scripts/status.sh", "--json"],
      {
        env: {
          ...process.env,
          TOKEN_METER_CLAUDE_INSTALL_ROOT: installRoot,
          TOKEN_METER_CLAUDE_STATE_DIR: stateDirectory,
          TOKEN_METER_LAUNCH_AGENTS_DIR: launchAgentsDirectory,
          TOKEN_METER_CLAUDE_LOG_DIR: logDirectory,
          TOKEN_METER_LAUNCHCTL: launchctl,
        },
      },
    );
    const status = JSON.parse(statusOutput);
    assert.equal(status.installed, true);
    assert.equal(status.launchAgentLoaded, false);
    assert.equal(status.claudeRestartRequired, false);

    await execFileAsync(
      "/bin/bash",
      ["integrations/claude-desktop/scripts/uninstall.sh", "--purge-state"],
      {
        env: {
          ...process.env,
          TOKEN_METER_CLAUDE_INSTALL_ROOT: installRoot,
          TOKEN_METER_CLAUDE_STATE_DIR: stateDirectory,
          TOKEN_METER_LAUNCH_AGENTS_DIR: launchAgentsDirectory,
          TOKEN_METER_CLAUDE_LOG_DIR: logDirectory,
          TOKEN_METER_LAUNCHCTL: launchctl,
        },
      },
    );
    assert.equal(existsSync(installRoot), false);
    assert.equal(existsSync(stateDirectory), false);
    assert.equal(
      existsSync(
        path.join(
          launchAgentsDirectory,
          "com.sergiochan.token-meter.claude-desktop.plist",
        ),
      ),
      false,
    );
    assert.equal(existsSync(claudeExecutable), true);
  },
);
