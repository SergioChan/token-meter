import assert from "node:assert/strict";
import test from "node:test";
import { isNewerVersion } from "../src/core/registry-client.mjs";

test("isNewerVersion compares strict x.y.z", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.1.10", "0.1.9"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.equal(isNewerVersion("garbage", "0.1.0"), false);
  assert.equal(isNewerVersion("1.0", "0.1.0"), false);
});
