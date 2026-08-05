import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test(
  "the macOS verifier rejects an unsigned lookalike before returning its runtime",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-fake-app-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const appPath = path.join(directory, "ChatGPT.app");
    const contents = path.join(appPath, "Contents");
    const nodePath = path.join(contents, "Resources", "cua_node", "bin", "node");
    await mkdir(path.dirname(nodePath), { recursive: true });
    await writeFile(
      path.join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.openai.codex</string>
</dict></plist>
`,
    );
    await writeFile(nodePath, "#!/bin/bash\nexit 0\n");
    await chmod(nodePath, 0o755);
    const canonicalAppPath = await realpath(appPath);

    await assert.rejects(
      execFileAsync("/bin/bash", [
        "scripts/verify-codex-app-macos.sh",
        canonicalAppPath,
      ]),
      (error) => String(error.stderr).includes("signature verification failed"),
    );
  },
);
