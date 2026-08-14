import { MetricsEngine } from "../../../src/core/metrics-engine.mjs";
import { loadOrCreateIdentity } from "../../../src/core/identity.mjs";
import { UsageHistory } from "../../../src/core/usage-history.mjs";
import { ClaudeDesktopSessionStore } from "./desktop-session-store.mjs";
import { ClaudeTranscriptStore } from "./transcript-store.mjs";

export class ClaudeSnapshotRuntime {
  constructor({
    sessionsDirectory,
    projectsDirectory,
    now = Date.now,
    sessionStore = null,
    transcriptStore = null,
    metricsEngine = null,
    identity = undefined,
    identityDir = undefined,
    usageHistory = undefined,
    usageTtlMs = 300_000,
  } = {}) {
    if (!sessionsDirectory) throw new TypeError("sessionsDirectory is required");
    if (!projectsDirectory) throw new TypeError("projectsDirectory is required");
    if (typeof now !== "function") throw new TypeError("now must be a function");
    this.now = now;
    this.sessionStore =
      sessionStore ?? new ClaudeDesktopSessionStore({ sessionsDirectory });
    this.transcriptStore =
      transcriptStore ?? new ClaudeTranscriptStore({ projectsDirectory });
    this.metricsEngine = metricsEngine ?? new MetricsEngine();
    this.identity = identity;
    this.identityDir = identityDir;
    this.identityMemo = null;
    this.usageHistory = usageHistory;
    this.usageTtlMs = usageTtlMs;
    this.usageMemo = null;
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

  async snapshot(desktopSessionId) {
    const session = await this.sessionStore.resolve(desktopSessionId);
    if (session.status !== "resolved") return session;

    const files = await this.transcriptStore.refresh({ session });
    const snapshot = this.metricsEngine.snapshot(files, {
      threadId: session.desktopSessionId,
      hostName: "Claude Desktop",
      nowMs: this.now(),
    });
    snapshot.binding = {
      source: "claude-desktop-session-metadata",
      exact: snapshot.status === "bound",
      desktopSessionId: session.desktopSessionId,
      cliSessionId: session.cliSessionId,
      model: session.model,
    };
    snapshot.usageMethod = "claude-transcript-raw";
    const identity = this.#identity();
    snapshot.meterId = identity?.meterId ?? null;
    snapshot.meterHandle = identity?.handle ?? null;
    snapshot.sharingEnabled = identity?.sharing?.enabled ?? false;
    snapshot.handlePrompted = identity?.handlePromptedAtMs != null;
    snapshot.meterStats = this.#usageStats();
    return snapshot;
  }
}
