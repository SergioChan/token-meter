import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test(
  "Claude model catalog invalidates a cached context window after an app update",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "token-meter-claude-catalog-"),
    );
    context.after(() => rm(directory, { recursive: true, force: true }));
    const catalog = path.join(directory, "app.asar");
    const harness = path.join(directory, "main.swift");
    const executable = path.join(directory, "catalog-test");
    await writeFile(
      catalog,
      `models=[{id:"claude-test",context:{window:1000000}}]`,
    );
    await writeFile(
      harness,
      `import Foundation

let catalog = URL(fileURLWithPath: CommandLine.arguments[1])
let resolver = ClaudeContextWindowResolver(modelCatalogURL: catalog)
precondition(resolver.resolve(model: "claude-test") == 1_000_000)
try "models=[{id:\\"claude-test\\",context:{window:200000}}]".write(
    to: catalog,
    atomically: true,
    encoding: .utf8
)
try FileManager.default.setAttributes(
    [.modificationDate: Date(timeIntervalSinceNow: 5)],
    ofItemAtPath: catalog.path
)
precondition(resolver.resolve(model: "claude-test") == 200_000)
precondition(resolver.resolve(model: nil) == nil)
`,
    );
    await execFileAsync("/usr/bin/swiftc", [
      "integrations/claude-desktop/native/ClaudeModelCatalog.swift",
      harness,
      "-o",
      executable,
    ]);
    const result = await execFileAsync(executable, [catalog]);
    assert.equal(result.stderr, "");
  },
);
