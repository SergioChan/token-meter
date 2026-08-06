import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { verifyClaudeBundleIdentity } from "../integrations/claude-desktop/src/app-verifier.mjs";

const execFileAsync = promisify(execFile);

test("bundle verification accepts only the signed Anthropic Claude identity", () => {
  assert.doesNotThrow(() =>
    verifyClaudeBundleIdentity({
      bundleId: "com.anthropic.claudefordesktop",
      teamId: "Q6L2SF6YDW",
    }),
  );
  assert.throws(
    () =>
      verifyClaudeBundleIdentity({
        bundleId: "com.anthropic.claudefordesktop",
        teamId: "ATTACKER01",
      }),
    /unexpected signing identity/,
  );
});

test(
  "the Claude macOS verifier rejects an unsigned lookalike",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "token-meter-fake-claude-app-"),
    );
    context.after(() => rm(directory, { recursive: true, force: true }));
    const appPath = path.join(directory, "Claude.app");
    const contents = path.join(appPath, "Contents");
    const executable = path.join(contents, "MacOS", "Claude");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(
      path.join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string>
</dict></plist>
`,
    );
    await writeFile(executable, "#!/bin/bash\nexit 0\n");
    await chmod(executable, 0o755);
    const canonicalAppPath = await realpath(appPath);

    await assert.rejects(
      execFileAsync("/bin/bash", [
        "scripts/verify-claude-app-macos.sh",
        canonicalAppPath,
      ]),
      (error) => String(error.stderr).includes("signature verification failed"),
    );
  },
);
