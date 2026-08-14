import assert from "node:assert/strict";
import test from "node:test";
import {
  createLeaderboardUrl,
  isNewerVersion,
  uploadUsage,
} from "../src/core/registry-client.mjs";
import {
  createIdentity,
  verifySignedPayload,
} from "../src/core/identity.mjs";
import { communityWebBase } from "../src/core/registry-config.mjs";

test("usage uploads sign the rolling seven-day session count", async () => {
  const previousRegistry = process.env.TOKEN_METER_REGISTRY_URL;
  const previousFetch = globalThis.fetch;
  const identity = createIdentity(1_000);
  let signed = null;
  try {
    process.env.TOKEN_METER_REGISTRY_URL = "https://registry.example";
    globalThis.fetch = async (_url, options) => {
      signed = JSON.parse(options.body);
      return new Response(JSON.stringify({ ok: true, ignored: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await uploadUsage(identity, {
      generatedAtMs: Date.now(),
      days: [],
      stats: {
        lifetimeTokens: 100,
        currentStreakDays: 2,
        longestStreakDays: 3,
        sessionCount: 9,
        sessionsLast7Days: 4,
        peakDay: null,
        byPlatform: {
          claudeCode: { tokens: 40 },
          codex: { tokens: 60 },
          cline: { tokens: 0 },
        },
      },
    });
    assert.equal(verifySignedPayload(signed), true);
    assert.equal(signed.payload.stats.sessionCount, 9);
    assert.equal(signed.payload.stats.sessionsLast7Days, 4);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRegistry == null) delete process.env.TOKEN_METER_REGISTRY_URL;
    else process.env.TOKEN_METER_REGISTRY_URL = previousRegistry;
  }
});

test("isNewerVersion compares strict x.y.z", () => {
  assert.equal(isNewerVersion("0.2.0", "0.1.0"), true);
  assert.equal(isNewerVersion("1.0.0", "0.9.9"), true);
  assert.equal(isNewerVersion("0.1.10", "0.1.9"), true);
  assert.equal(isNewerVersion("0.1.0", "0.1.0"), false);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.equal(isNewerVersion("garbage", "0.1.0"), false);
  assert.equal(isNewerVersion("1.0", "0.1.0"), false);
});

test("communityWebBase accepts HTTPS and loopback development URLs only", () => {
  const previous = process.env.TOKEN_METER_WEB_URL;
  try {
    process.env.TOKEN_METER_WEB_URL = "https://community.example/path/?ignored=yes#ignored";
    assert.equal(communityWebBase(), "https://community.example/path");

    process.env.TOKEN_METER_WEB_URL = "http://127.0.0.1:4173";
    assert.equal(communityWebBase(), "http://127.0.0.1:4173");

    process.env.TOKEN_METER_WEB_URL = "http://community.example";
    assert.equal(communityWebBase(), null);

    process.env.TOKEN_METER_WEB_URL = "file:///tmp/leaderboard.html";
    assert.equal(communityWebBase(), null);
  } finally {
    if (previous == null) delete process.env.TOKEN_METER_WEB_URL;
    else process.env.TOKEN_METER_WEB_URL = previous;
  }
});

test("createLeaderboardUrl signs a pairing request and keeps its secret in the fragment", async () => {
  const previousRegistry = process.env.TOKEN_METER_REGISTRY_URL;
  const previousWeb = process.env.TOKEN_METER_WEB_URL;
  const previousFetch = globalThis.fetch;
  const identity = createIdentity(1_000);
  const pairingCode = "A".repeat(32);
  let request = null;

  try {
    process.env.TOKEN_METER_REGISTRY_URL = "https://registry.example";
    process.env.TOKEN_METER_WEB_URL = "https://community.example";
    globalThis.fetch = async (url, options) => {
      request = { url: String(url), options };
      return new Response(
        JSON.stringify({ code: pairingCode, expiresAtMs: 302_000 }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const pairingUrl = new URL(await createLeaderboardUrl(identity, 2_000));
    assert.equal(request.url, "https://registry.example/api/v1/browser-pairings");
    assert.equal(request.options.method, "POST");
    const signed = JSON.parse(request.options.body);
    assert.equal(verifySignedPayload(signed), true);
    assert.deepEqual(signed.payload, {
      kind: "browser-pairing",
      meterId: identity.meterId,
      publicKey: identity.publicKey,
      generatedAtMs: 2_000,
    });
    assert.equal(signed.privateKeyPem, undefined);

    assert.equal(pairingUrl.origin, "https://community.example");
    assert.equal(pairingUrl.pathname, "/leaderboard");
    assert.equal(pairingUrl.search, "");
    assert.equal(pairingUrl.hash, `#pair=${pairingCode}`);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRegistry == null) delete process.env.TOKEN_METER_REGISTRY_URL;
    else process.env.TOKEN_METER_REGISTRY_URL = previousRegistry;
    if (previousWeb == null) delete process.env.TOKEN_METER_WEB_URL;
    else process.env.TOKEN_METER_WEB_URL = previousWeb;
  }
});
