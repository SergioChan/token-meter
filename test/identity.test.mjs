import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSignedUsageReport,
  createIdentity,
  deriveMeterId,
  isMeterId,
  loadOrCreateIdentity,
  setSharingEnabled,
  verifySignedUsageReport,
} from "../src/core/identity.mjs";

test("meter IDs are deterministic, well-formed, and key-bound", () => {
  const identity = createIdentity();
  assert.ok(isMeterId(identity.meterId));
  const der = Buffer.from(identity.publicKey, "base64");
  assert.equal(deriveMeterId(der), identity.meterId);
  const other = createIdentity();
  assert.notEqual(other.meterId, identity.meterId);
});

test("identity persists across loads and never regenerates", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-meter-identity-"));
  const first = loadOrCreateIdentity(dir);
  const second = loadOrCreateIdentity(dir);
  assert.equal(second.meterId, first.meterId);
  assert.equal(second.privateKeyPem, first.privateKeyPem);
  const mode = statSync(join(dir, "identity.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("sharing is opt-in and defaults to disabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "token-meter-identity-"));
  const identity = loadOrCreateIdentity(dir);
  assert.equal(identity.sharing.enabled, false);
  const updated = setSharingEnabled(true, dir);
  assert.equal(updated.sharing.enabled, true);
  const reloaded = JSON.parse(readFileSync(join(dir, "identity.json"), "utf8"));
  assert.equal(reloaded.sharing.enabled, true);
});

test("handles are validated, persisted, and unclaimed by default", async () => {
  const { setHandle, isValidHandle } = await import("../src/core/identity.mjs");
  const dir = mkdtempSync(join(tmpdir(), "token-meter-identity-"));
  assert.equal(isValidHandle("sergio-chan"), true);
  assert.equal(isValidHandle("Bad Handle!"), false);
  assert.throws(() => setHandle("Bad Handle!", dir));
  const updated = setHandle("sergio", dir);
  assert.equal(updated.handle, "sergio");
  assert.equal(updated.handleClaimed, false);
  const cleared = setHandle(null, dir);
  assert.equal(cleared.handle, null);
});

test("usage reports verify and reject tampering", () => {
  const identity = createIdentity();
  const report = buildSignedUsageReport(identity, {
    periodStartMs: 1_000,
    periodEndMs: 2_000,
    totalTokens: 4_200_000,
    sessionCount: 12,
    peakTokensPerMinute: 90_000,
  });
  assert.equal(verifySignedUsageReport(report), true);

  const inflated = { ...report, payload: { ...report.payload, totalTokens: 9_999_999 } };
  assert.equal(verifySignedUsageReport(inflated), false);

  const impostor = createIdentity();
  const stolen = {
    ...report,
    payload: { ...report.payload, meterId: impostor.meterId, publicKey: impostor.publicKey },
  };
  assert.equal(verifySignedUsageReport(stolen), false);
});
