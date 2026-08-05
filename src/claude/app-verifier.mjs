import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const CLAUDE_BUNDLE_ID = "com.anthropic.claudefordesktop";
export const ANTHROPIC_TEAM_ID = "Q6L2SF6YDW";
export const DEFAULT_CLAUDE_APP_PATH = "/Applications/Claude.app";

const execFileAsync = promisify(execFile);

export function verifyClaudeBundleIdentity({ bundleId, teamId }) {
  if (bundleId !== CLAUDE_BUNDLE_ID || teamId !== ANTHROPIC_TEAM_ID) {
    throw new Error(
      "Refusing a Claude application with an unexpected signing identity",
    );
  }
}

export async function verifyClaudeApplicationBundle(
  appPath = DEFAULT_CLAUDE_APP_PATH,
) {
  const expectedPath = path.resolve(appPath);
  const canonicalPath = await realpath(expectedPath).catch(() => null);
  if (canonicalPath !== expectedPath) {
    throw new Error("Refusing a missing or symlinked Claude application bundle");
  }

  const { stdout: bundleId } = await execFileAsync("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    path.join(canonicalPath, "Contents", "Info.plist"),
  ]);
  await execFileAsync("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    canonicalPath,
  ]);
  const { stderr: signature } = await execFileAsync("/usr/bin/codesign", [
    "-dv",
    "--verbose=4",
    canonicalPath,
  ]);
  const teamId =
    String(signature).match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
  verifyClaudeBundleIdentity({ bundleId: bundleId.trim(), teamId });

  const executablePath = path.join(
    canonicalPath,
    "Contents",
    "MacOS",
    "Claude",
  );
  await access(executablePath, constants.X_OK).catch(() => {
    throw new Error("The verified Claude executable is missing or not executable");
  });

  return {
    appPath: canonicalPath,
    executablePath,
  };
}
