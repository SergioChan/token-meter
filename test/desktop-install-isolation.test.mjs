import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test(
  "Codex and Claude installers preserve isolated application roots",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "token-meter-desktop-isolation-"),
    );
    context.after(() => rm(directory, { recursive: true, force: true }));

    const home = path.join(directory, "Home");
    const baseRoot = path.join(
      home,
      "Library",
      "Application Support",
      "Token Meter",
    );
    const launchAgents = path.join(home, "Library", "LaunchAgents");
    const logs = path.join(home, "Library", "Logs", "Token Meter");
    const claudeApp = path.join(directory, "Claude.app");
    const verifier = path.join(directory, "verify-app.sh");
    const launchctl = path.join(directory, "launchctl");
    const claudeExecutable = path.join(claudeApp, "Contents", "MacOS", "Claude");
    const modelCatalog = path.join(claudeApp, "Contents", "Resources", "app.asar");
    const nodePath = existsSync("/opt/homebrew/bin/node")
      ? "/opt/homebrew/bin/node"
      : process.execPath;

    await Promise.all([
      mkdir(path.dirname(claudeExecutable), { recursive: true }),
      mkdir(path.dirname(modelCatalog), { recursive: true }),
      mkdir(launchAgents, { recursive: true }),
    ]);
    await writeFile(claudeExecutable, "#!/bin/bash\nexit 0\n");
    await writeFile(modelCatalog, "fixture");
    await chmod(claudeExecutable, 0o755);
    await writeFile(verifier, `#!/bin/bash\nprintf '%s\\n' ${JSON.stringify(nodePath)}\n`);
    await chmod(verifier, 0o755);
    await writeFile(
      launchctl,
      "#!/bin/bash\n[ \"${1:-}\" = print ] && exit 1\nexit 0\n",
    );
    await chmod(launchctl, 0o755);

    const environment = {
      ...process.env,
      HOME: home,
      TOKEN_METER_LAUNCH_AGENTS_DIR: launchAgents,
      TOKEN_METER_LAUNCHCTL: launchctl,
      TOKEN_METER_CODEX_VERIFIER: verifier,
      TOKEN_METER_CLAUDE_VERIFIER: verifier,
      TOKEN_METER_INSTALL_ROOT: baseRoot,
      TOKEN_METER_LOG_DIR: path.join(logs, "Codex Desktop"),
      TOKEN_METER_CLAUDE_LOG_DIR: path.join(logs, "Claude Desktop"),
      CODEX_APP_PATH: path.join(directory, "ChatGPT.app"),
    };

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
      { env: environment },
    );

    const claudeRoot = path.join(baseRoot, "Claude Desktop");
    const claudeSentinel = path.join(claudeRoot, "installation-sentinel");
    await writeFile(claudeSentinel, "preserve");

    await execFileAsync(
      "/bin/bash",
      ["scripts/install-token-meter-macos.sh"],
      { env: environment },
    );

    const codexRoot = path.join(baseRoot, "Codex Desktop");
    await Promise.all([
      access(claudeSentinel),
      access(path.join(codexRoot, "src", "cli.mjs")),
      access(path.join(codexRoot, "runtime", "token-meter-ui.js")),
    ]);
    assert.notEqual(codexRoot, claudeRoot);

    await execFileAsync(
      "/bin/bash",
      ["scripts/uninstall-token-meter-macos.sh"],
      { env: environment },
    );
    await access(claudeSentinel);
  },
);
