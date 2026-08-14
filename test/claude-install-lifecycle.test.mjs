import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const label = "com.sergiochan.token-meter.claude-desktop";
const bundleID = "com.sergiochan.token-meter.claude-overlay";

async function makeExecutable(file, source) {
  await writeFile(file, source);
  await chmod(file, 0o755);
}

test(
  "Claude uninstaller refuses a recursive removal root that resolves to HOME",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-safe-remove-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const home = path.join(directory, "Home");
    const sentinel = path.join(home, "keep-me");
    await mkdir(home, { recursive: true });
    await writeFile(sentinel, "preserve");

    await assert.rejects(
      execFileAsync("/bin/bash", ["integrations/claude-desktop/scripts/uninstall.sh"], {
        env: {
          ...process.env,
          HOME: home,
          TOKEN_METER_CLAUDE_INSTALL_ROOT: home,
          TOKEN_METER_CLAUDE_STATE_DIR: path.join(directory, "state"),
          TOKEN_METER_LAUNCH_AGENTS_DIR: path.join(directory, "agents"),
          TOKEN_METER_CLAUDE_LOG_DIR: path.join(directory, "logs"),
          TOKEN_METER_LAUNCHCTL: "/usr/bin/false",
        },
      }),
      /unsafe removal root|refusing.*HOME/i,
    );
    assert.equal(await readFile(sentinel, "utf8"), "preserve");
  },
);

test(
  "Claude uninstaller rejects a removal path with a symlinked ancestor",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-symlink-remove-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const actual = path.join(directory, "actual");
    const alias = path.join(directory, "alias");
    const installRoot = path.join(alias, "Claude Desktop");
    await mkdir(path.join(actual, "Claude Desktop"), { recursive: true });
    await symlink(actual, alias);
    await writeFile(path.join(actual, "Claude Desktop", "keep-me"), "preserve");

    await assert.rejects(
      execFileAsync("/bin/bash", ["integrations/claude-desktop/scripts/uninstall.sh"], {
        env: {
          ...process.env,
          TOKEN_METER_CLAUDE_INSTALL_ROOT: installRoot,
          TOKEN_METER_CLAUDE_STATE_DIR: path.join(directory, "state"),
          TOKEN_METER_LAUNCH_AGENTS_DIR: path.join(directory, "agents"),
          TOKEN_METER_CLAUDE_LOG_DIR: path.join(directory, "logs"),
          TOKEN_METER_LAUNCHCTL: "/usr/bin/false",
        },
      }),
      /symlinked ancestor/i,
    );
    assert.equal(
      await readFile(path.join(actual, "Claude Desktop", "keep-me"), "utf8"),
      "preserve",
    );
  },
);

test(
  "Claude status distinguishes process, Accessibility, overlay, bridge, and Session binding",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-health-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const installRoot = path.join(directory, "install");
    const stateDirectory = path.join(directory, "state");
    const launchAgentsDirectory = path.join(directory, "agents");
    const executable = path.join(
      installRoot,
      "Token Meter for Claude.app",
      "Contents",
      "MacOS",
      "TokenMeterClaudeOverlay",
    );
    await Promise.all([
      mkdir(path.dirname(executable), { recursive: true }),
      mkdir(stateDirectory, { recursive: true }),
      mkdir(launchAgentsDirectory, { recursive: true }),
    ]);
    // Direct invocation deliberately claims permission. Status must still use
    // the verified LaunchAgent process's health state, which says false.
    const source = `#include <string.h>\n#include <unistd.h>\nint main(int c,char**v){if(c>1&&!strcmp(v[1],"--check-accessibility"))return 0;sleep(30);return 0;}\n`;
    const cFile = path.join(directory, "health-fixture.c");
    await writeFile(cFile, source);
    await execFileAsync("/usr/bin/clang", [cFile, "-o", executable]);
    const child = spawn(executable, [], { stdio: "ignore" });
    context.after(() => {
      if (child.exitCode == null) child.kill("SIGTERM");
    });
    await writeFile(
      path.join(stateDirectory, "health.json"),
      JSON.stringify({
        schemaVersion: 1,
        pid: child.pid,
        accessibilityGranted: false,
        overlayReady: false,
        bridgeHealthy: false,
        sessionBound: false,
      }),
    );
    await writeFile(path.join(launchAgentsDirectory, `${label}.plist`), "fixture");
    const launchctl = path.join(directory, "launchctl");
    await makeExecutable(launchctl, "#!/bin/bash\n[ \"${1:-}\" = print ]\n");

    const { stdout } = await execFileAsync(
      "/bin/bash",
      ["integrations/claude-desktop/scripts/status.sh", "--json"],
      {
        env: {
          ...process.env,
          TOKEN_METER_CLAUDE_INSTALL_ROOT: installRoot,
          TOKEN_METER_CLAUDE_STATE_DIR: stateDirectory,
          TOKEN_METER_LAUNCH_AGENTS_DIR: launchAgentsDirectory,
          TOKEN_METER_LAUNCHCTL: launchctl,
        },
      },
    );
    const status = JSON.parse(stdout);
    assert.equal(status.running, true);
    assert.equal(status.accessibilityGranted, false);
    assert.equal(status.overlayReady, false);
    assert.equal(status.bridgeHealthy, false);
    assert.equal(status.sessionBound, false);
    child.kill("SIGTERM");
    await once(child, "exit");
  },
);

test(
  "Claude installer restores the previous app and LaunchAgent when readiness fails",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-rollback-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const installRoot = path.join(directory, "install");
    const stateDirectory = path.join(directory, "state");
    const launchAgentsDirectory = path.join(directory, "agents");
    const logDirectory = path.join(directory, "logs");
    const claudeApp = path.join(directory, "Claude.app");
    const verifier = path.join(directory, "verify.sh");
    const launchctl = path.join(directory, "launchctl");
    const loaded = path.join(directory, "loaded");
    const oldSentinel = path.join(installRoot, "old-version");
    const plist = path.join(launchAgentsDirectory, `${label}.plist`);
    const claudeExecutable = path.join(claudeApp, "Contents", "MacOS", "Claude");
    await Promise.all([
      mkdir(installRoot, { recursive: true }),
      mkdir(stateDirectory, { recursive: true }),
      mkdir(launchAgentsDirectory, { recursive: true }),
      mkdir(logDirectory, { recursive: true }),
      mkdir(path.dirname(claudeExecutable), { recursive: true }),
      mkdir(path.join(claudeApp, "Contents", "Resources"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(oldSentinel, "old"),
      writeFile(path.join(installRoot, ".token-meter-installation"), `${label}\n`),
      writeFile(plist, "old-plist"),
      writeFile(loaded, "1"),
      writeFile(path.join(claudeApp, "Contents", "Resources", "app.asar"), "fixture"),
    ]);
    await makeExecutable(claudeExecutable, "#!/bin/bash\nexit 0\n");
    await makeExecutable(verifier, "#!/bin/bash\nexit 0\n");
    await makeExecutable(
      launchctl,
      `#!/bin/bash\ncase "${'$'}{1:-}" in\nprint) [ -f ${JSON.stringify(loaded)} ];;\nbootout) rm -f ${JSON.stringify(loaded)};;\nbootstrap) touch ${JSON.stringify(loaded)};;\nesac\n`,
    );

    const nodePath = existsSync("/opt/homebrew/bin/node")
      ? "/opt/homebrew/bin/node"
      : process.execPath;
    await assert.rejects(
      execFileAsync(
        "/bin/bash",
        [
          "integrations/claude-desktop/scripts/install.sh",
          "--node",
          nodePath,
          "--claude-app",
          claudeApp,
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
            TOKEN_METER_READY_TIMEOUT_SECONDS: "1",
          },
          timeout: 30_000,
        },
      ),
      /did not become ready.*previous installation was restored/i,
    );
    assert.equal(await readFile(oldSentinel, "utf8"), "old");
    assert.equal(await readFile(plist, "utf8"), "old-plist");
  },
);

test(
  "Claude uninstall can explicitly reset its Accessibility grant",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-tcc-reset-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const installRoot = path.join(directory, "install");
    const stateDirectory = path.join(directory, "state");
    const logDirectory = path.join(directory, "logs");
    const launchAgentsDirectory = path.join(directory, "agents");
    const tccLog = path.join(directory, "tcc.log");
    const tccutil = path.join(directory, "tccutil");
    await Promise.all([
      mkdir(installRoot, { recursive: true }),
      mkdir(stateDirectory, { recursive: true }),
      mkdir(logDirectory, { recursive: true }),
      mkdir(launchAgentsDirectory, { recursive: true }),
    ]);
    for (const root of [installRoot, stateDirectory, logDirectory]) {
      await writeFile(path.join(root, ".token-meter-installation"), `${label}\n`);
    }
    await makeExecutable(
      tccutil,
      `#!/bin/bash\nprintf '%s\\n' "${'$'}*" > ${JSON.stringify(tccLog)}\n`,
    );
    await execFileAsync(
      "/bin/bash",
      [
        "integrations/claude-desktop/scripts/uninstall.sh",
        "--purge-state",
        "--reset-accessibility",
      ],
      {
        env: {
          ...process.env,
          TOKEN_METER_CLAUDE_INSTALL_ROOT: installRoot,
          TOKEN_METER_CLAUDE_STATE_DIR: stateDirectory,
          TOKEN_METER_LAUNCH_AGENTS_DIR: launchAgentsDirectory,
          TOKEN_METER_CLAUDE_LOG_DIR: logDirectory,
          TOKEN_METER_LAUNCHCTL: "/usr/bin/false",
          TOKEN_METER_TCCUTIL: tccutil,
        },
      },
    );
    assert.equal(await readFile(tccLog, "utf8"), `reset Accessibility ${bundleID}\n`);
  },
);
