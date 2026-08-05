export const CLAUDE_BUNDLE_ID = "com.anthropic.claudefordesktop";
export const ANTHROPIC_TEAM_ID = "Q6L2SF6YDW";

export function verifyClaudeBundleIdentity({ bundleId, teamId }) {
  if (bundleId !== CLAUDE_BUNDLE_ID || teamId !== ANTHROPIC_TEAM_ID) {
    throw new Error(
      "Refusing a Claude application with an unexpected signing identity",
    );
  }
}
