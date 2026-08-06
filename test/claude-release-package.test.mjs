import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test(
  "Claude release builder creates a self-contained architecture asset",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-release-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const nodeRoot = path.dirname(path.dirname(process.execPath));
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    await execFileAsync(
      "integrations/claude-desktop/scripts/build-release.sh",
      [
        "--version",
        "0.2.0",
        "--build-number",
        "2",
        "--arch",
        arch,
        "--node-root",
        nodeRoot,
        "--output-dir",
        directory,
        "--ad-hoc",
      ],
      { timeout: 60_000 },
    );

    const asset = path.join(directory, `token-meter-claude-macos-${arch}.zip`);
    await access(asset);
    const { stdout: listing } = await execFileAsync("/usr/bin/ditto", [
      "-x",
      "-k",
      asset,
      path.join(directory, "expanded"),
    ]);
    assert.equal(listing, "");
    const app = path.join(directory, "expanded", "Token Meter for Claude.app");
    await Promise.all([
      access(path.join(app, "Contents", "Resources", "Node", "bin", "node")),
      access(
        path.join(
          app,
          "Contents",
          "Resources",
          "TokenMeterRuntime",
          "src",
          "cli.mjs",
        ),
      ),
    ]);
    await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    const metadata = JSON.parse(
      await readFile(path.join(directory, `token-meter-claude-macos-${arch}.json`), "utf8"),
    );
    assert.equal(metadata.version, "0.2.0");
    assert.equal(metadata.architecture, arch);
    assert.equal(metadata.notarized, false);
  },
);

test("Claude release workflow requires Developer ID and notarization secrets", async () => {
  const source = await readFile(".github/workflows/release-claude.yml", "utf8");
  assert.match(source, /MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64/);
  assert.match(source, /APPLE_NOTARY_KEY_ID/);
  assert.match(source, /APPLE_NOTARY_ISSUER_ID/);
  assert.match(source, /APPLE_NOTARY_KEY_BASE64/);
  assert.match(source, /Developer ID Application: T54 Labs Inc\. \(DVA9SD82WQ\)/);
  assert.match(source, /arm64/);
  assert.match(source, /x86_64/);
  assert.match(source, /softprops\/action-gh-release/);
});
