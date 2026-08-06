import { MetricsEngine } from "../../../src/core/metrics-engine.mjs";
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
    };
    snapshot.usageMethod = "claude-transcript-raw";
    return snapshot;
  }
}
