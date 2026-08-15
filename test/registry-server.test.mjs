import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_SESSION_COOKIE,
  RegistryServer,
} from "../server/registry-server.mjs";
import { FileRegistryStore } from "../server/registry-store.mjs";
import { createIdentity, signPayload } from "../src/core/identity.mjs";

const nowMs = Date.parse("2026-08-13T12:00:00Z");

async function startRegistry({ profileReads = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "token-meter-registry-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>home</title>");
  const dataFile = join(dir, "data.json");
  const server = new RegistryServer({
    ...(profileReads
      ? { store: new FileRegistryStore({ dataFile, profileReads: true }) }
      : { dataFile }),
    webDir: dir,
    now: () => nowMs,
  });
  await server.start(0);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

function signedPost(base, path, identity, payload) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signPayload(identity, {
      meterId: identity.meterId,
      publicKey: identity.publicKey,
      generatedAtMs: nowMs,
      ...payload,
    })),
  });
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

function usageReportV2(identity, {
  total,
  input,
  output,
  cacheRead,
  cacheWrite,
  activeDates,
  hour,
}) {
  const hours = Array(24).fill(0);
  hours[hour] = total;
  const weekdayTokens = Array(7).fill(0);
  for (const date of activeDates) {
    weekdayTokens[new Date(`${date}T12:00:00`).getDay()] += Math.floor(total / activeDates.length);
  }
  return signPayload(identity, {
    kind: "usage-v2",
    reportVersion: 2,
    meterId: identity.meterId,
    publicKey: identity.publicKey,
    handle: identity.handle ?? null,
    generatedAtMs: nowMs,
    days: activeDates.map((date, index) => ({
      date,
      total: index === activeDates.length - 1
        ? total - Math.floor(total / activeDates.length) * (activeDates.length - 1)
        : Math.floor(total / activeDates.length),
    })),
    stats: {
      lifetimeTokens: total,
      sessionCount: 1,
      sessionsLast7Days: 1,
      currentStreakDays: activeDates.length,
      longestStreakDays: activeDates.length,
      peakDay: null,
      byPlatform: { claudeCode: 0, codex: total, cline: 0 },
    },
    weekTokens: total,
    merge: {
      version: 1,
      tokenBreakdown: { input, output, cacheRead, cacheWrite },
      hours,
      weekdayTokens,
      sessionTokenHistogram: [0, 1, 0, 0, 0, 0, 0, 0],
      activeDates,
    },
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

test("a hosted release serves metadata and redirects the download", async () => {
  // Production: no DMG bytes in the container — /api/v1/latest comes from
  // configured metadata and the download route bounces to the release asset.
  const dir = mkdtempSync(join(tmpdir(), "token-meter-registry-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>home</title>");
  const digest = "a".repeat(64);
  const assetUrl = "https://github.com/example/repo/releases/download/v0.2.5/TokenWidget-0.2.5.dmg";
  const server = new RegistryServer({
    dataFile: join(dir, "data.json"),
    webDir: dir,
    latestRelease: {
      version: "0.2.5",
      path: "/download/token-widget.dmg",
      sha256: digest,
      size: 12345,
    },
    dmgRedirectUrl: assetUrl,
  });
  await server.start(0);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const latest = await (await fetch(`${base}/api/v1/latest`)).json();
    assert.deepEqual(latest, {
      version: "0.2.5",
      path: "/download/token-widget.dmg",
      sha256: digest,
      size: 12345,
    });
    const download = await fetch(`${base}/download/token-widget.dmg`, { redirect: "manual" });
    assert.equal(download.status, 302);
    assert.equal(download.headers.get("location"), assetUrl);
  } finally {
    await server.stop();
  }
});

test("a local dmg file still wins over the redirect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "token-meter-registry-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>home</title>");
  writeFileSync(join(dir, "app.dmg"), "fake-dmg-bytes");
  const server = new RegistryServer({
    dataFile: join(dir, "data.json"),
    webDir: dir,
    dmgFile: join(dir, "app.dmg"),
    latestVersion: "0.2.5",
    dmgRedirectUrl: "https://example.com/should-not-be-used.dmg",
  });
  await server.start(0);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const download = await fetch(`${base}/download/token-widget.dmg`, { redirect: "manual" });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), "fake-dmg-bytes");
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

test("owner invitation joins one independent device without reclaiming the handle", async () => {
  const { server, base } = await startRegistry({ profileReads: true });
  try {
    const owner = { ...createIdentity(), handle: "sergio" };
    const member = createIdentity();
    const attacker = { ...createIdentity(), handle: "sergio" };
    assert.equal((await signedPost(base, "/api/v1/claim", owner, {
      kind: "claim",
      handle: "sergio",
    })).status, 200);
    assert.equal((await signedPost(base, "/api/v1/claim", attacker, {
      kind: "claim",
      handle: "sergio",
    })).status, 409);

    const inviteResponse = await signedPost(base, "/api/v2/profile-invites", owner, {
      kind: "profile-invite",
      mode: "add",
    });
    assert.equal(inviteResponse.status, 201);
    const invite = await inviteResponse.json();
    assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(invite.handle, "sergio");
    assert.equal(invite.expiresAtMs, nowMs + 10 * 60_000);

    const join = await signedPost(base, "/api/v2/profile-join", member, {
      kind: "profile-join",
      inviteToken: invite.token,
      deviceLabel: "Studio Mac",
    });
    assert.equal(join.status, 200);
    const joined = await join.json();
    assert.equal(joined.joined, true);
    assert.equal(joined.handle, "sergio");
    assert.equal(joined.role, "member");
    assert.equal(joined.deviceCount, 2);

    const replay = await signedPost(base, "/api/v2/profile-join", createIdentity(), {
      kind: "profile-join",
      inviteToken: invite.token,
      deviceLabel: "Replay Mac",
    });
    assert.equal(replay.status, 410);

    const membership = await signedPost(base, "/api/v2/profile-membership", member, {
      kind: "profile-membership",
    });
    assert.deepEqual(await membership.json(), {
      member: true,
      profileId: owner.meterId,
      handle: "sergio",
      role: "member",
      sharingEnabled: false,
      deviceLabel: "Studio Mac",
      joinedAtMs: nowMs,
      lastReportedAtMs: null,
    });
    assert.equal((await signedPost(base, "/api/v2/profile-invites", member, {
      kind: "profile-invite",
      mode: "add",
    })).status, 403);

    await fetch(`${base}/api/v1/report`, {
      method: "POST",
      body: JSON.stringify(usageReport(owner, 100)),
    });
    await fetch(`${base}/api/v1/report`, {
      method: "POST",
      body: JSON.stringify(usageReport(member, 250)),
    });
    const profile = await (await fetch(`${base}/api/v1/profile/sergio`)).json();
    assert.equal(profile.weekTokens, 350);
    assert.equal(profile.stats.lifetimeTokens, 350);
    const board = await (await fetch(`${base}/api/v1/leaderboard`)).json();
    assert.equal(board.rows.length, 1);
    assert.equal(board.rows[0].handle, "sergio");

    const devices = await signedPost(base, "/api/v2/profile-devices", owner, {
      kind: "profile-devices",
    });
    const listed = await devices.json();
    assert.equal(listed.devices.length, 2);
    assert.equal(listed.devices.find((device) => device.meterId === member.meterId).deviceLabel, "Studio Mac");

    const revoke = await signedPost(base, "/api/v2/profile-devices/revoke", owner, {
      kind: "profile-device-revoke",
      targetMeterId: member.meterId,
    });
    assert.equal(revoke.status, 200);
    assert.equal((await (await fetch(`${base}/api/v1/profile/sergio`)).json()).weekTokens, 100);
    assert.deepEqual(
      await (await signedPost(base, "/api/v2/profile-membership", member, {
        kind: "profile-membership",
      })).json(),
      { member: false },
    );
    assert.equal((await fetch(`${base}/api/v1/report`, {
      method: "POST",
      body: JSON.stringify(usageReport(member, 999)),
    })).status, 403);
    assert.equal((await signedPost(base, "/api/v1/browser-pairings", member, {
      kind: "browser-pairing",
    })).status, 403);
    assert.equal((await signedPost(base, "/api/v2/profile-devices/revoke", owner, {
      kind: "profile-device-revoke",
      targetMeterId: owner.meterId,
    })).status, 409);
  } finally {
    await server.stop();
  }
});

test("one invitation admits at most one concurrent device", async () => {
  const { server, base } = await startRegistry({ profileReads: true });
  try {
    const owner = { ...createIdentity(), handle: "concurrent" };
    await signedPost(base, "/api/v1/claim", owner, {
      kind: "claim",
      handle: owner.handle,
    });
    const invite = await (await signedPost(base, "/api/v2/profile-invites", owner, {
      kind: "profile-invite",
      mode: "add",
    })).json();
    const candidates = [createIdentity(), createIdentity()];
    const responses = await Promise.all(candidates.map((identity, index) =>
      signedPost(base, "/api/v2/profile-join", identity, {
        kind: "profile-join",
        inviteToken: invite.token,
        deviceLabel: `Candidate ${index + 1}`,
      })));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 410]);
    const devices = await (await signedPost(base, "/api/v2/profile-devices", owner, {
      kind: "profile-devices",
    })).json();
    assert.equal(devices.devices.filter((device) => device.revokedAtMs == null).length, 2);
  } finally {
    await server.stop();
  }
});

test("replacement and owner transfer preserve one globally unique handle", async () => {
  const { server, base } = await startRegistry({ profileReads: true });
  try {
    const owner = { ...createIdentity(), handle: "handoff" };
    const oldMember = createIdentity();
    const replacement = createIdentity();
    await signedPost(base, "/api/v1/claim", owner, { kind: "claim", handle: owner.handle });
    const firstInvite = await (await signedPost(base, "/api/v2/profile-invites", owner, {
      kind: "profile-invite", mode: "add",
    })).json();
    await signedPost(base, "/api/v2/profile-join", oldMember, {
      kind: "profile-join", inviteToken: firstInvite.token, deviceLabel: "Old Mac",
    });
    await fetch(`${base}/api/v1/report`, {
      method: "POST",
      body: JSON.stringify(usageReport(oldMember, 500)),
    });

    const replacementInvite = await (await signedPost(base, "/api/v2/profile-invites", owner, {
      kind: "profile-invite",
      mode: "replace",
      replaceMeterId: oldMember.meterId,
    })).json();
    const replacementJoin = await signedPost(base, "/api/v2/profile-join", replacement, {
      kind: "profile-join",
      inviteToken: replacementInvite.token,
      deviceLabel: "New Mac",
    });
    assert.equal(replacementJoin.status, 200);
    assert.equal((await (await fetch(`${base}/api/v1/profile/handoff`)).json()).shared, false);

    const transfer = await signedPost(base, "/api/v2/profile-devices/transfer-owner", owner, {
      kind: "profile-owner-transfer",
      targetMeterId: replacement.meterId,
    });
    assert.equal(transfer.status, 200);
    assert.equal((await signedPost(base, "/api/v2/profile-invites", owner, {
      kind: "profile-invite", mode: "add",
    })).status, 403);
    assert.equal((await signedPost(base, "/api/v2/profile-invites", replacement, {
      kind: "profile-invite", mode: "add",
    })).status, 201);
    assert.equal((await signedPost(base, "/api/v1/claim", createIdentity(), {
      kind: "claim", handle: "handoff",
    })).status, 409);

    const devices = await (await signedPost(base, "/api/v2/profile-devices", replacement, {
      kind: "profile-devices",
    })).json();
    assert.equal(devices.devices.find((device) => device.meterId === replacement.meterId).role, "owner");
    assert.equal(devices.devices.find((device) => device.meterId === owner.meterId).role, "member");
    assert.notEqual(devices.devices.find((device) => device.meterId === oldMember.meterId).revokedAtMs, null);
  } finally {
    await server.stop();
  }
});

test("v2 reports merge raw numeric buckets without exposing session identifiers", async () => {
  const { server, base } = await startRegistry({ profileReads: true });
  try {
    const owner = { ...createIdentity(), handle: "mergeable" };
    const member = createIdentity();
    await signedPost(base, "/api/v1/claim", owner, {
      kind: "claim",
      handle: owner.handle,
    });
    const invite = await (await signedPost(base, "/api/v2/profile-invites", owner, {
      kind: "profile-invite",
      mode: "add",
    })).json();
    await signedPost(base, "/api/v2/profile-join", member, {
      kind: "profile-join",
      inviteToken: invite.token,
      deviceLabel: "Second Mac",
    });

    const first = usageReportV2(owner, {
      total: 100,
      input: 20,
      output: 10,
      cacheRead: 60,
      cacheWrite: 10,
      activeDates: ["2026-08-13", "2026-08-14"],
      hour: 8,
    });
    const second = usageReportV2(member, {
      total: 200,
      input: 100,
      output: 40,
      cacheRead: 40,
      cacheWrite: 20,
      activeDates: ["2026-08-14", "2026-08-15"],
      hour: 9,
    });
    assert.equal((await fetch(`${base}/api/v2/report`, {
      method: "POST",
      body: JSON.stringify(first),
    })).status, 200);
    assert.equal((await fetch(`${base}/api/v2/report`, {
      method: "POST",
      body: JSON.stringify(second),
    })).status, 200);

    const profile = await (await fetch(`${base}/api/v1/profile/mergeable`)).json();
    assert.equal(profile.stats.lifetimeTokens, 300);
    assert.equal(profile.stats.daysActive, 3);
    assert.equal(profile.stats.currentStreakDays, 3);
    assert.equal(profile.stats.longestStreakDays, 3);
    assert.equal(profile.stats.peakHour, 9);
    assert.equal(profile.stats.cacheReadShare, 100 / 250);
    assert.equal(profile.stats.outputShare, 50 / 300);
    assert.equal(profile.stats.merge, undefined);
    const privateMerge = server.store.data.profiles[owner.meterId].stats.merge;
    assert.deepEqual(privateMerge.tokenBreakdown, {
      input: 120,
      output: 50,
      cacheRead: 100,
      cacheWrite: 30,
    });
    assert.deepEqual(privateMerge.activeDates, [
      "2026-08-13",
      "2026-08-14",
      "2026-08-15",
    ]);
    assert.equal(JSON.stringify(second).includes("sessionId"), false);

    const malformed = structuredClone(second);
    malformed.payload.merge.sessionTokenHistogram = [1];
    const resigned = signPayload(member, malformed.payload);
    assert.equal((await fetch(`${base}/api/v2/report`, {
      method: "POST",
      body: JSON.stringify(resigned),
    })).status, 422);
  } finally {
    await server.stop();
  }
});
