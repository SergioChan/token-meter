import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Codex controller launches the app bundle with CDP arguments", async () => {
  const source = await readFile("scripts/token-meter-service-macos.sh", "utf8");
  assert.match(source, /\/usr\/bin\/open -n "\$APP_PATH" --args/);
  assert.doesNotMatch(source, /\/usr\/bin\/open -na/);
  assert.match(source, /MAX_RECOVERY_ATTEMPTS=2/);
  assert.doesNotMatch(source, /HANDLED_PID="\$NEW_PID"/);
});

test("one-shot Codex launcher uses the same app-bundle invocation", async () => {
  const source = await readFile("scripts/start-codex-meter-macos.sh", "utf8");
  assert.match(source, /\/usr\/bin\/open -n "\$APP_PATH" --args/);
  assert.doesNotMatch(source, /\/usr\/bin\/open -na/);
});
