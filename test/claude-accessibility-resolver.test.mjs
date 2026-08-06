import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const sessionId = "local_00000000-0000-4000-8000-000000000201";

test(
  "Claude Accessibility resolver accepts one exact Code web area only",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "token-meter-claude-ax-"),
    );
    context.after(() => rm(directory, { recursive: true, force: true }));
    const harness = path.join(directory, "main.swift");
    const executable = path.join(directory, "resolver-test");
    await writeFile(
      harness,
      `import ApplicationServices
import Foundation

let sessionID = ${JSON.stringify(sessionId)}
let valid = ClaudeAXURLCandidate(
    role: "AXWebArea",
    url: "https://claude.ai/epitaxy/\\(sessionID)"
)
precondition(resolveUniqueClaudeCodeSessionID(from: [valid]) == sessionID)
precondition(resolveUniqueClaudeCodeSessionID(from: [
    ClaudeAXURLCandidate(role: "AXLink", url: valid.url)
]) == nil)
precondition(resolveUniqueClaudeCodeSessionID(from: [valid, valid]) == nil)
precondition(resolveUniqueClaudeCodeSessionID(from: [
    ClaudeAXURLCandidate(
        role: "AXWebArea",
        url: "https://claude.ai/epitaxy/\\(sessionID)/settings"
    )
]) == nil)
precondition(resolveUniqueClaudeCodeSessionID(from: [
    ClaudeAXURLCandidate(
        role: "AXWebArea",
        url: "https://example.com/epitaxy/\\(sessionID)"
    )
]) == nil)
precondition(exactContextWindowTokens(
    role: "AXButton",
    value: "Context window 596.0k / 1.0M (59.6%)"
) == 1_000_000)
precondition(exactContextWindowTokens(
    role: "AXStaticText",
    value: "596.0k / 1.0M"
) == nil)
precondition(exactContextWindowTokens(
    role: "AXButton",
    value: "message says 596.0k / 1.0M today"
) == nil)
`,
    );

    await execFileAsync("/usr/bin/swiftc", [
      "integrations/claude-desktop/native/ClaudeAccessibility.swift",
      harness,
      "-framework",
      "ApplicationServices",
      "-o",
      executable,
    ]);
    const result = await execFileAsync(executable);
    assert.equal(result.stderr, "");
  },
);
