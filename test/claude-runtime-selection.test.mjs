import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const helper = "integrations/claude-desktop/scripts/runtime-selection.sh";

async function fakeNode(file, compatible) {
  await writeFile(file, `#!/bin/bash\nexit ${compatible ? 0 : 1}\n`);
  await chmod(file, 0o755);
}

test("Claude runtime selection skips an older Node and chooses a compatible candidate", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-node-select-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const oldNode = path.join(directory, "node-old");
  const currentNode = path.join(directory, "node-current");
  await Promise.all([fakeNode(oldNode, false), fakeNode(currentNode, true)]);

  const { stdout } = await execFileAsync(
    "/bin/bash",
    [
      "-c",
      'source "$1"; TOKEN_METER_NODE_CANDIDATES="$2:$3" token_meter_find_compatible_node',
      "bash",
      helper,
      oldNode,
      currentNode,
    ],
  );
  assert.equal(stdout.trim(), currentNode);
});

test("Claude runtime selection fails an explicitly selected incompatible Node", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-node-explicit-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const oldNode = path.join(directory, "node-old");
  const currentNode = path.join(directory, "node-current");
  await Promise.all([fakeNode(oldNode, false), fakeNode(currentNode, true)]);

  await assert.rejects(
    execFileAsync(
      "/bin/bash",
      [
        "-c",
        'source "$1"; TOKEN_METER_NODE_CANDIDATES="$3" token_meter_resolve_node "$2"',
        "bash",
        helper,
        oldNode,
        currentNode,
      ],
    ),
    /Node\.js 22\.12 or newer is required/i,
  );
});

test(
  "Claude source-install doctor reports all build prerequisites",
  { skip: process.platform !== "darwin" },
  async () => {
    const nodePath = await realpath(
      existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath,
    );
    const { stdout } = await execFileAsync(
      "/bin/bash",
      ["integrations/claude-desktop/scripts/doctor.sh", "--json"],
      { env: { ...process.env, TOKEN_METER_NODE: nodePath } },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.macosSupported, true);
    assert.equal(result.xcodeCommandLineTools, true);
    assert.equal(result.swiftCompiler, true);
    assert.equal(result.codeSigningTools, true);
    assert.equal(result.nodeCompatible, true);
    assert.equal(result.readyForSourceInstall, true);
  },
);
