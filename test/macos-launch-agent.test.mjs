import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("LaunchAgent rendering preserves arguments and escapes XML", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-launch-agent-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "token-meter.plist");
  const root = path.join(directory, "Token & Meter");
  const service = path.join(root, "scripts", "service.sh");
  const appPath = "/Applications/Codex & Test.app";

  await execFileAsync(process.execPath, [
    "scripts/render-launch-agent.mjs",
    "--output",
    output,
    "--label",
    "com.sergiochan.token-meter",
    "--service",
    service,
    "--root",
    root,
    "--app-path",
    appPath,
    "--port",
    "9334",
    "--stdout",
    path.join(directory, "service.log"),
    "--stderr",
    path.join(directory, "service-error.log"),
  ]);

  const source = await readFile(output, "utf8");
  assert.match(source, /Token &amp; Meter/);
  assert.match(source, /Codex &amp; Test\.app/);
  assert.match(source, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.doesNotMatch(source, /<key>KeepAlive<\/key>/);
  if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/plutil", ["-lint", output]);
  }
});

test("LaunchAgent rendering rejects privileged or invalid ports", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [
      "scripts/render-launch-agent.mjs",
      "--output",
      "/tmp/token-meter.plist",
      "--label",
      "com.sergiochan.token-meter",
      "--service",
      "/tmp/service.sh",
      "--root",
      "/tmp/token-meter",
      "--app-path",
      "/Applications/ChatGPT.app",
      "--port",
      "80",
      "--stdout",
      "/tmp/out.log",
      "--stderr",
      "/tmp/error.log",
    ]),
    /between 1024 and 65535/,
  );
});
