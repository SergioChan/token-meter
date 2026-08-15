import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProfileInvite,
  createLeaderboardUrl,
  isNewerVersion,
  joinExistingProfile,
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
  let requestUrl = null;
  try {
    process.env.TOKEN_METER_REGISTRY_URL = "https://registry.example";
    globalThis.fetch = async (url, options) => {
      requestUrl = String(url);
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
    assert.equal(requestUrl, "https://registry.example/api/v2/report");
    assert.equal(signed.payload.kind, "usage-v2");
    assert.equal(signed.payload.reportVersion, 2);
    assert.equal(signed.payload.stats.sessionCount, 9);
    assert.equal(signed.payload.stats.sessionsLast7Days, 4);
    assert.equal(signed.payload.merge.sessionTokenHistogram.reduce((sum, value) => sum + value, 0), 9);
    assert.equal("sessionId" in signed.payload.merge, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRegistry == null) delete process.env.TOKEN_METER_REGISTRY_URL;
    else process.env.TOKEN_METER_REGISTRY_URL = previousRegistry;
  }
});

test("usage upload falls back to v1 only when a registry has no v2 route", async () => {
  const previousRegistry = process.env.TOKEN_METER_REGISTRY_URL;
  const previousFetch = globalThis.fetch;
  const identity = createIdentity(1_000);
  const requests = [];
  try {
    process.env.TOKEN_METER_REGISTRY_URL = "https://registry.example";
    globalThis.fetch = async (url, options) => {
      requests.push({ url: String(url), signed: JSON.parse(options.body) });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await uploadUsage(identity, {
      generatedAtMs: Date.now(),
      days: [],
      hours: Array(24).fill(0),
      stats: {
        lifetimeTokens: 0,
        currentStreakDays: 0,
        longestStreakDays: 0,
        sessionCount: 0,
        sessionsLast7Days: 0,
        peakDay: null,
        medianSessionTokens: 0,
        sessionTokenHistogram: Array(8).fill(0),
        byPlatform: {
          claudeCode: { tokens: 0, sessions: 0 },
          codex: { tokens: 0, sessions: 0 },
          cline: { tokens: 0, sessions: 0 },
        },
      },
    });
    assert.deepEqual(requests.map(({ url }) => url), [
      "https://registry.example/api/v2/report",
      "https://registry.example/api/v1/report",
    ]);
    assert.equal(requests[0].signed.payload.kind, "usage-v2");
    assert.equal(requests[1].signed.payload.kind, "usage");
    assert.equal("merge" in requests[1].signed.payload, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRegistry == null) delete process.env.TOKEN_METER_REGISTRY_URL;
    else process.env.TOKEN_METER_REGISTRY_URL = previousRegistry;
  }
});

test("Profile invite and join requests are signed and persist membership locally", async () => {
  const previousRegistry = process.env.TOKEN_METER_REGISTRY_URL;
  const previousFetch = globalThis.fetch;
  const identity = createIdentity(1_000);
  const profileId = "TM-2222-3333-4444";
  const directory = mkdtempSync(join(tmpdir(), "token-widget-profile-client-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "identity.json"), `${JSON.stringify(identity, null, 2)}\n`);
  const requests = [];
  try {
    process.env.TOKEN_METER_REGISTRY_URL = "https://registry.example";
    globalThis.fetch = async (url, options) => {
      const signed = JSON.parse(options.body);
      requests.push({ url: String(url), signed });
      assert.equal(verifySignedPayload(signed), true);
      if (String(url).endsWith("/profile-invites")) {
        return new Response(JSON.stringify({
          token: "A".repeat(43),
          profileId,
          handle: "sergio",
          expiresAtMs: 20_000,
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        joined: true,
        profileId,
        handle: "sergio",
        role: "member",
        deviceCount: 2,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    await createProfileInvite(identity, { mode: "add" }, 2_000);
    await joinExistingProfile(identity, {
      inviteToken: "A".repeat(43),
      deviceLabel: "Studio Mac",
    }, directory, 3_000);
    assert.deepEqual(requests.map(({ url }) => url), [
      "https://registry.example/api/v2/profile-invites",
      "https://registry.example/api/v2/profile-join",
    ]);
    assert.equal(requests[0].signed.payload.kind, "profile-invite");
    assert.equal(requests[1].signed.payload.kind, "profile-join");
    const persisted = JSON.parse(readFileSync(join(directory, "identity.json"), "utf8"));
    assert.equal(persisted.handle, "sergio");
    assert.equal(persisted.handleClaimed, true);
    assert.deepEqual(persisted.profile, {
      profileId,
      role: "member",
      deviceLabel: "Studio Mac",
      joinedAtMs: 3_000,
      lastConfirmedAtMs: 3_000,
    });
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
