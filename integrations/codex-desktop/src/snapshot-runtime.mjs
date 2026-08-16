// Produces Codex meter snapshots without CDP. Identity comes from the Codex
// state database (the active user thread), token telemetry from the same
// rollout files the CDP path already read. This mirrors ClaudeSnapshotRuntime's
// interface so the native overlay and its bridge treat both hosts the same way.

import os from "node:os";
import path from "node:path";
import { MetricsEngine } from "../../../src/core/metrics-engine.mjs";
import { RolloutStore } from "../../../src/core/rollout-store.mjs";
import { loadOrCreateIdentity } from "../../../src/core/identity.mjs";
import { UsageHistory } from "../../../src/core/usage-history.mjs";
import { readActiveCodexThread } from "./thread-state.mjs";

export function defaultSessionsDirectory() {
  return path.join(os.homedir(), ".codex", "sessions");
}

export class CodexSnapshotRuntime {
  constructor({
    sessionsDirectory = defaultSessionsDirectory(),
    now = Date.now,
    rolloutStore = null,
    metricsEngine = null,
    // Injected in tests; in production the active thread is read from the
    // Codex state database each snapshot.
    resolveActiveThread = readActiveCodexThread,
    identity = undefined,
    identityDir = undefined,
    usageHistory = undefined,
    usageTtlMs = 300_000,
    historyFileLimit = 100,
  } = {}) {
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.now = now;
    this.rolloutStore =
      rolloutStore ?? new RolloutStore({ sessionsDirectory, historyFileLimit });
    this.metricsEngine = metricsEngine ?? new MetricsEngine();
    this.resolveActiveThread = resolveActiveThread;
    this.identity = identity;
    this.identityDir = identityDir;
    this.identityMemo = null;
    this.usageHistory = usageHistory;
    this.usageTtlMs = usageTtlMs;
    this.usageMemo = null;
  }

  async snapshot() {
    const active = this.resolveActiveThread();
    if (active?.threadId == null) {
      const unbound = {
        status: "unbound",
        binding: { source: "codex-state-db", exact: false },
        reason: "No active Codex user thread was found in the state database.",
      };
      this.#decorate(unbound);
      return unbound;
    }
    const files = await this.rolloutStore.refresh({
      activeThreadIds: [active.threadId],
    });
    const snapshot = this.metricsEngine.snapshot(files, {
      threadId: active.threadId,
      nowMs: this.now(),
      hostName: "Codex",
    });
    snapshot.binding = {
      source: "codex-state-db",
      exact: snapshot.status === "bound",
      threadId: active.threadId,
    };
    snapshot.usageMethod = "codex-rollout-raw";
    this.#decorate(snapshot);
    return snapshot;
  }

  // Streak and lifetime stats come from the full-history scan; refresh on a
  // slow TTL so the per-tick snapshot path never pays the scan cost.
  #usageStats() {
    if (this.usageHistory === null) return null;
    const nowMs = Date.now();
    if (this.usageMemo == null || nowMs - this.usageMemo.atMs > this.usageTtlMs) {
      let stats = null;
      try {
        this.usageHistory ??= new UsageHistory();
        const collected = this.usageHistory.collect().stats;
        stats = {
          lifetimeTokens: collected.lifetimeTokens,
          currentStreakDays: collected.currentStreakDays,
        };
      } catch {
        stats = null;
      }
      this.usageMemo = { atMs: nowMs, stats };
    }
    return this.usageMemo.stats;
  }

  // Injected identities are fixed (tests); otherwise re-read on a short TTL so
  // consent granted from the dashboard page reaches the overlay promptly.
  #identity() {
    if (this.identity !== undefined) return this.identity;
    const nowMs = Date.now();
    if (this.identityMemo == null || nowMs - this.identityMemo.atMs > 5_000) {
      let value = null;
      try {
        value = this.identityDir
          ? loadOrCreateIdentity(this.identityDir)
          : loadOrCreateIdentity();
      } catch {
        value = null;
      }
      this.identityMemo = { atMs: nowMs, value };
    }
    return this.identityMemo.value;
  }

  #decorate(snapshot) {
    const identity = this.#identity();
    snapshot.meterId = identity?.meterId ?? null;
    snapshot.meterHandle = identity?.handle ?? null;
    snapshot.sharingEnabled = identity?.sharing?.enabled ?? false;
    snapshot.handlePrompted = identity?.handlePromptedAtMs != null;
    snapshot.meterStats = this.#usageStats();
  }
}
