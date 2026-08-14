import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_SESSION_COOKIE,
  RegistryServer,
} from "../server/registry-server.mjs";
import { createIdentity, signPayload } from "../src/core/identity.mjs";

const nowMs = Date.parse("2026-08-13T12:00:00Z");

async function startRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "token-meter-registry-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>home</title>");
  const server = new RegistryServer({
    dataFile: join(dir, "data.json"),
    webDir: dir,
    now: () => nowMs,
  });
  await server.start(0);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

function usageReport(identity, total) {
  return signPayload(identity, {
    kind: "usage",
    meterId: identity.meterId,
    publicKey: identity.publicKey,
    handle: identity.handle ?? null,
    generatedAtMs: nowMs,
    days: [{ date: "2026-08-13", total }],
    stats: {
      lifetimeTokens: total,
      sessionCount: 1,
      sessionsLast7Days: 1,
      currentStreakDays: 1,
      longestStreakDays: 1,
      peakDay: { date: "2026-08-13", tokens: total },
      byPlatform: { claudeCode: total, codex: 0, cline: 0 },
    },
    weekTokens: total,
  });
}

test("claims are signed, first-come-first-served, and idempotent", async () => {
  const { server, base } = await startRegistry();
  try {
    const alice = { ...createIdentity(), handle: "alex" };
    const mallory = { ...createIdentity(), handle: "alex" };
    const claim = (identity) =>
      fetch(`${base}/api/v1/claim`, {
        method: "POST",
        body: JSON.stringify(
          signPayload(identity, {
            kind: "claim", meterId: identity.meterId, publicKey: identity.publicKey,
            handle: identity.handle, generatedAtMs: nowMs,
          }),
        ),
      });

    const available = await (await fetch(`${base}/api/v1/handle/alex/available`)).json();
    assert.equal(available.available, true);
    assert.equal((await claim(alice)).status, 200);
    assert.equal((await claim(alice)).status, 200);
    assert.equal((await claim(mallory)).status, 409);
    const taken = await (await fetch(`${base}/api/v1/handle/alex/available`)).json();
    assert.equal(taken.available, false);

    const forged = signPayload(mallory, {
      kind: "claim", meterId: alice.meterId, publicKey: alice.publicKey,
      handle: "stolen", generatedAtMs: nowMs,
    });
    const forgedResponse = await fetch(`${base}/api/v1/claim`, { method: "POST", body: JSON.stringify(forged) });
    assert.equal(forgedResponse.status, 401);
  } finally {
    await server.stop();
  }
});

test("liveness does not depend on registry storage", async () => {
  const { server, base } = await startRegistry();
  try {
    assert.deepEqual(await (await fetch(`${base}/api/v1/live`)).json(), {
      ok: true,
    });
    assert.deepEqual(await (await fetch(`${base}/api/v1/health`)).json(), {
      ok: true,
      meters: 0,
    });
  } finally {
    await server.stop();
  }
});

test("signed usage reports feed leaderboard and profile", async () => {
  const { server, base } = await startRegistry();
  try {
    const identity = { ...createIdentity(), handle: "casey" };
    await fetch(`${base}/api/v1/claim`, {
      method: "POST",
      body: JSON.stringify(signPayload(identity, {
        kind: "claim", meterId: identity.meterId, publicKey: identity.publicKey,
        handle: "casey", generatedAtMs: nowMs,
      })),
    });
    const report = signPayload(identity, {
      kind: "usage", meterId: identity.meterId, publicKey: identity.publicKey, handle: "casey",
      generatedAtMs: nowMs, days: [{ date: "2026-08-13", total: 5_000_000 }],
      stats: { lifetimeTokens: 9_000_000, sessionCount: 4, sessionsLast7Days: 2, currentStreakDays: 2,
        longestStreakDays: 3, peakDay: { date: "2026-08-13", tokens: 5_000_000 },
        byPlatform: { claudeCode: 9_000_000, codex: 0, cline: 0 } },
      weekTokens: 5_000_000,
    });
    assert.equal((await fetch(`${base}/api/v1/report`, { method: "POST", body: JSON.stringify(report) })).status, 200);

    const board = await (await fetch(`${base}/api/v1/leaderboard`)).json();
    assert.equal(board.rows[0].name, "@casey");
    assert.equal(board.rows[0].tokens, 5_000_000);
    assert.equal(board.rows[0].sessions, 2);
    assert.equal(board.rows[0].sessionWindowDays, 7);

    const profile = await (await fetch(`${base}/api/v1/profile/casey`)).json();
    assert.equal(profile.stats.lifetimeTokens, 9_000_000);
    assert.equal(profile.days.length, 1);
    assert.equal((await fetch(`${base}/api/v1/profile/nobody`)).status, 404);
  } finally {
    await server.stop();
  }
});

test("passwordless browser pairing is signed, one-time, and resolves the viewer rank", async () => {
  const { server, base } = await startRegistry();
  try {
    const alice = createIdentity();
    const bob = createIdentity();
    const pairingRequest = signPayload(alice, {
      kind: "browser-pairing",
      meterId: alice.meterId,
      publicKey: alice.publicKey,
      generatedAtMs: nowMs,
    });
    const pairingResponse = await fetch(`${base}/api/v1/browser-pairings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pairingRequest),
    });
    assert.equal(pairingResponse.status, 201);
    const pairing = await pairingResponse.json();
    assert.match(pairing.code, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(pairing.expiresAtMs, nowMs + 5 * 60_000);

    const untrusted = await fetch(`${base}/api/v1/browser-sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ code: pairing.code }),
    });
    assert.equal(untrusted.status, 403);

    const exchange = await fetch(`${base}/api/v1/browser-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ code: pairing.code }),
    });
    assert.equal(exchange.status, 200);
    const setCookie = exchange.headers.get("set-cookie");
    assert.match(setCookie, new RegExp(`^${BROWSER_SESSION_COOKIE}=[A-Za-z0-9_-]{43};`));
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    const cookie = setCookie.split(";", 1)[0];
    const beforeSharing = await (
      await fetch(`${base}/api/v1/me`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(beforeSharing.viewer.meterId, alice.meterId);
    assert.equal(beforeSharing.viewer.rank, null);
    assert.equal(beforeSharing.viewer.sharingReported, false);

    const replay = await fetch(`${base}/api/v1/browser-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ code: pairing.code }),
    });
    assert.equal(replay.status, 401);

    assert.equal((await fetch(`${base}/api/v1/report`, {
      method: "POST", body: JSON.stringify(usageReport(bob, 20_000)),
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v1/report`, {
      method: "POST", body: JSON.stringify(usageReport(alice, 10_000)),
    })).status, 200);

    const me = await (
      await fetch(`${base}/api/v1/me`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(me.viewer.rank, 2);
    assert.equal(me.viewer.totalMeters, 2);
    assert.equal(me.viewer.tokens, 10_000);
    assert.equal(me.viewer.sessions, 1);
    assert.equal(me.viewer.sessionWindowDays, 7);
    assert.equal(me.viewer.sharingReported, true);
    const board = await (await fetch(`${base}/api/v1/leaderboard`)).json();
    assert.equal(board.rows[1].rowId, me.viewer.rowId);
    assert.equal(board.rows[1].name, `${alice.meterId.slice(0, 10)}…`);

    const logout = await fetch(`${base}/api/v1/browser-sessions/current`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: base },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(
      (await fetch(`${base}/api/v1/me`, { headers: { Cookie: cookie } })).status,
      401,
    );
  } finally {
    await server.stop();
  }
});

test("browser pairing rejects forged and stale identity proofs", async () => {
  const { server, base } = await startRegistry();
  try {
    const owner = createIdentity();
    const attacker = createIdentity();
    const forged = signPayload(attacker, {
      kind: "browser-pairing",
      meterId: owner.meterId,
      publicKey: owner.publicKey,
      generatedAtMs: nowMs,
    });
    assert.equal((await fetch(`${base}/api/v1/browser-pairings`, {
      method: "POST",
      body: JSON.stringify(forged),
    })).status, 401);
    const stale = signPayload(owner, {
      kind: "browser-pairing",
      meterId: owner.meterId,
      publicKey: owner.publicKey,
      generatedAtMs: nowMs - 16 * 60_000,
    });
    assert.equal((await fetch(`${base}/api/v1/browser-pairings`, {
      method: "POST",
      body: JSON.stringify(stale),
    })).status, 422);
  } finally {
    await server.stop();
  }
});

test("stale reports are rejected and older snapshots cannot replace newer data", async () => {
  const { server, base } = await startRegistry();
  try {
    const identity = createIdentity();
    const usage = (generatedAtMs, total) => signPayload(identity, {
      kind: "usage",
      meterId: identity.meterId,
      publicKey: identity.publicKey,
      handle: null,
      generatedAtMs,
      days: [{ date: "2026-08-13", total }],
      stats: {
        lifetimeTokens: total,
        sessionCount: 1,
        currentStreakDays: 1,
        longestStreakDays: 1,
        peakDay: { date: "2026-08-13", tokens: total },
        byPlatform: { claudeCode: total, codex: 0, cline: 0 },
      },
      weekTokens: total,
    });
    const report = (body) => fetch(`${base}/api/v1/report`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    assert.equal((await report(usage(nowMs - 16 * 60_000, 1))).status, 422);
    assert.equal((await report(usage(nowMs, 10_000))).status, 200);
    const older = await report(usage(nowMs - 1, 1));
    assert.equal(older.status, 200);
    assert.equal((await older.json()).ignored, true);

    const board = await (await fetch(`${base}/api/v1/leaderboard`)).json();
    assert.equal(board.rows[0].tokens, 10_000);
    assert.equal(board.rows[0].sessions, null);
    assert.equal(board.rows[0].sessionWindowDays, 7);
  } finally {
    await server.stop();
  }
});

test("latest release endpoint reports version and dmg digest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "token-meter-registry-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>home</title>");
  writeFileSync(join(dir, "app.dmg"), "fake-dmg-bytes");
  const server = new RegistryServer({
    dataFile: join(dir, "data.json"),
    webDir: dir,
    dmgFile: join(dir, "app.dmg"),
    latestVersion: "0.2.0",
  });
  await server.start(0);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const latest = await (await fetch(`${base}/api/v1/latest`)).json();
    assert.equal(latest.version, "0.2.0");
    assert.equal(latest.path, "/download/token-widget.dmg");
    assert.match(latest.sha256, /^[0-9a-f]{64}$/);
    assert.equal(latest.size, "fake-dmg-bytes".length);
  } finally {
    await server.stop();
  }
});

test("latest release endpoint 404s without a published dmg", async () => {
  const { server, base } = await startRegistry();
  try {
    assert.equal((await fetch(`${base}/api/v1/latest`)).status, 404);
  } finally {
    await server.stop();
  }
});

test("extended aggregate stats round-trip; malformed extras reject the report", async () => {
  const { server, base } = await startRegistry();
  try {
    const identity = createIdentity();
    const report = (extraStats) => {
      const signed = usageReport(identity, 1_000);
      Object.assign(signed.payload.stats, extraStats);
      return fetch(`${base}/api/v1/report`, {
        method: "POST",
        body: JSON.stringify(signPayload(identity, signed.payload)),
      });
    };

    // Legacy minimal payload still accepted (installed-client contract).
    assert.equal((await report({})).status, 200);

    const extended = {
      daysActive: 20, daysObserved: 30, avgPerActiveDay: 50,
      firstActivityDate: "2026-06-01", medianSessionTokens: 10,
      largestSessionTokens: 400, longestSessionMs: 7_200_000,
      cacheReadShare: 0.95, outputShare: 0.004, peakHour: 11, busiestWeekday: 4,
      hours: Array(24).fill(1),
      topDays: [{ date: "2026-08-13", tokens: 1_000 }],
      byPlatformSessions: { claudeCode: 5, codex: 1, cline: 0 },
    };
    assert.equal((await report(extended)).status, 200);

    await fetch(`${base}/api/v1/claim`, {
      method: "POST",
      body: JSON.stringify(signPayload(identity, {
        kind: "claim", meterId: identity.meterId, publicKey: identity.publicKey,
        handle: "stats", generatedAtMs: nowMs,
      })),
    });
    const profile = await (await fetch(`${base}/api/v1/profile/stats`)).json();
    assert.equal(profile.stats.peakHour, 11);
    assert.equal(profile.stats.hours.length, 24);
    assert.equal(profile.stats.byPlatformSessions.claudeCode, 5);

    assert.equal((await report({ hours: Array(23).fill(1) })).status, 422);
    assert.equal((await report({ cacheReadShare: 1.5 })).status, 422);
    assert.equal((await report({ peakHour: 24 })).status, 422);
    assert.equal((await report({ topDays: [{ date: "13/08", tokens: 1 }] })).status, 422);
  } finally {
    await server.stop();
  }
});

test("withdraw is signed, deletes the row from the board, and spares the handle", async () => {
  const { server, base } = await startRegistry();
  try {
    const alice = { ...createIdentity(), handle: "wanda" };
    const mallory = createIdentity();
    await fetch(`${base}/api/v1/claim`, {
      method: "POST",
      body: JSON.stringify(signPayload(alice, {
        kind: "claim", meterId: alice.meterId, publicKey: alice.publicKey,
        handle: "wanda", generatedAtMs: nowMs,
      })),
    });
    await fetch(`${base}/api/v1/report`, {
      method: "POST",
      body: JSON.stringify(usageReport(alice, 9_000)),
    });
    assert.equal(((await (await fetch(`${base}/api/v1/leaderboard`)).json()).rows).length, 1);

    // A forged withdrawal (mallory signing alice's identity) is rejected.
    const forged = signPayload(mallory, {
      kind: "withdraw", meterId: alice.meterId, publicKey: alice.publicKey,
      generatedAtMs: nowMs,
    });
    assert.equal(
      (await fetch(`${base}/api/v1/withdraw`, { method: "POST", body: JSON.stringify(forged) })).status,
      401,
    );

    // A stale signed withdrawal replayed later is rejected.
    const stale = signPayload(alice, {
      kind: "withdraw", meterId: alice.meterId, publicKey: alice.publicKey,
      generatedAtMs: nowMs - 16 * 60 * 1_000,
    });
    assert.equal(
      (await fetch(`${base}/api/v1/withdraw`, { method: "POST", body: JSON.stringify(stale) })).status,
      422,
    );

    const genuine = signPayload(alice, {
      kind: "withdraw", meterId: alice.meterId, publicKey: alice.publicKey,
      generatedAtMs: nowMs,
    });
    const response = await fetch(`${base}/api/v1/withdraw`, {
      method: "POST",
      body: JSON.stringify(genuine),
    });
    assert.deepEqual(await response.json(), { ok: true, wiped: true });
    assert.equal(((await (await fetch(`${base}/api/v1/leaderboard`)).json()).rows).length, 0);
    assert.deepEqual(
      await (await fetch(`${base}/api/v1/profile/wanda`)).json(),
      { handle: "wanda", shared: false },
    );
    assert.equal(
      (await (await fetch(`${base}/api/v1/handle/wanda/available`)).json()).available,
      false,
    );
  } finally {
    await server.stop();
  }
});
