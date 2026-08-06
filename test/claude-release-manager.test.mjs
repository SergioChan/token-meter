import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const manager = "scripts/token-meter-claude-macos.sh";

test("Claude release manager exposes install, status, and uninstall commands", async () => {
  const { stdout } = await execFileAsync("/bin/bash", [manager, "--help"]);
  assert.match(stdout, /install/);
  assert.match(stdout, /status/);
  assert.match(stdout, /uninstall/);
  assert.match(stdout, /--reset-accessibility/);
});

test("Claude release manager enforces signed and notarized release assets", async () => {
  const source = await readFile(manager, "utf8");
  assert.match(source, /checksums\.txt/);
  assert.match(source, /shasum -a 256/);
  assert.match(source, /codesign --verify --deep --strict/);
  assert.match(source, /TeamIdentifier/);
  assert.match(source, /DVA9SD82WQ/);
  assert.match(source, /spctl --assess --type execute/);
  assert.match(source, /Developer ID Application/);
  assert.match(source, /health\.json/);
  assert.match(source, /previous installation was restored/i);
  assert.doesNotMatch(source, /command -v node|swiftc|xcode-select/);
});

test("Claude release workflow publishes the standalone manager", async () => {
  const source = await readFile(".github/workflows/release-claude.yml", "utf8");
  assert.match(source, /token-meter-claude/);
  assert.match(source, /scripts\/token-meter-claude-macos\.sh/);
});
