// Tests must never touch a live registry.
process.env.TOKEN_METER_REGISTRY_URL = "";

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DashboardServer } from "../src/core/dashboard-server.mjs";

async function startServer() {
  const webDir = mkdtempSync(join(tmpdir(), "token-meter-web-"));
  writeFileSync(join(webDir, "dashboard.html"), "<!doctype html><title>dash</title>");
  const identityDir = mkdtempSync(join(tmpdir(), "token-meter-identity-"));
  const server = new DashboardServer({
    webDir,
    identityDir,
    usageHistory: { collect: () => ({ days: [], hours: [], stats: { lifetimeTokens: 7 } }) },
  });
  await server.start();
  return server;
}

test("sharing consent endpoint flips the flag and validates input", async () => {
  const server = await startServer();
  try {
    const token = new URL(server.url()).searchParams.get("token");
    const base = `http://127.0.0.1:${server.port}`;
    const bad = await fetch(`${base}/api/sharing?token=${token}`, {
      method: "POST",
      body: JSON.stringify({ enabled: "yes" }),
    });
    assert.equal(bad.status, 422);
    const on = await (
      await fetch(`${base}/api/sharing?token=${token}`, {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      })
    ).json();
    assert.equal(on.sharing.enabled, true);
    assert.equal(on.privateKeyPem, undefined);
  } finally {
    await server.stop();
  }
});

test("usage endpoint serves aggregated history", async () => {
  const server = await startServer();
  try {
    const token = new URL(server.url()).searchParams.get("token");
    const usage = await (
      await fetch(`http://127.0.0.1:${server.port}/api/usage?token=${token}`)
    ).json();
    assert.equal(usage.stats.lifetimeTokens, 7);
  } finally {
    await server.stop();
  }
});

test("dashboard server requires the nonce on every route", async () => {
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    for (const path of ["/", "/api/profile", "/?token=wrong"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 403, path);
    }
    const ok = await fetch(server.url());
    assert.equal(ok.status, 200);
  } finally {
    await server.stop();
  }
});

test("profile and handle claim round-trip without exposing the key", async () => {
  const server = await startServer();
  try {
    const token = new URL(server.url()).searchParams.get("token");
    const base = `http://127.0.0.1:${server.port}`;
    const profile = await (await fetch(`${base}/api/profile?token=${token}`)).json();
    assert.match(profile.meterId, /^TM-/);
    assert.equal(profile.handle, null);
    assert.equal(profile.privateKeyPem, undefined);

    const bad = await fetch(`${base}/api/handle?token=${token}`, {
      method: "POST",
      body: JSON.stringify({ handle: "Bad Handle!" }),
    });
    assert.equal(bad.status, 422);

    const claimed = await (
      await fetch(`${base}/api/handle?token=${token}`, {
        method: "POST",
        body: JSON.stringify({ handle: "chandler" }),
      })
    ).json();
    assert.equal(claimed.handle, "chandler");
    assert.equal(claimed.handleClaimed, false);
    assert.equal(claimed.privateKeyPem, undefined);
  } finally {
    await server.stop();
  }
});
