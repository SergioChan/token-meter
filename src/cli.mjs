#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MetricsEngine } from "./core/metrics-engine.mjs";
import { RolloutStore } from "./core/rollout-store.mjs";

function parseArguments(argv) {
  const [command = "snapshot", ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--thread-id") options.threadId = rest[++index];
    else if (value === "--sessions-dir") options.sessionsDirectory = rest[++index];
    else if (value === "--desktop-session-id") {
      options.desktopSessionId = rest[++index];
    } else if (value === "--claude-sessions-dir") {
      options.claudeSessionsDirectory = rest[++index];
    } else if (value === "--claude-projects-dir") {
      options.claudeProjectsDirectory = rest[++index];
    } else if (value === "--claude-cache-dir") {
      options.claudeCacheDirectory = rest[++index];
    } else if (value === "--strict") {
      options.strict = true;
    } else if (value === "--cdp-port") {
      options.cdpPort = Number(rest[++index]);
    } else if (value === "--set-handle") {
      options.setHandle = rest[++index];
    } else if (value === "--clear-handle") {
      options.clearHandle = true;
    } else if (value === "--sharing") {
      options.sharing = rest[++index];
    } else if (value === "--invite-token") {
      options.inviteToken = rest[++index];
    } else if (value === "--device-label") {
      options.deviceLabel = rest[++index];
    } else if (value === "--mode") {
      options.mode = rest[++index];
    } else if (value === "--replace-meter-id") {
      options.replaceMeterId = rest[++index];
    } else if (value === "--target-meter-id") {
      options.targetMeterId = rest[++index];
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const sessionsDirectory =
  options.sessionsDirectory ?? path.join(os.homedir(), ".codex", "sessions");

if (options.command === "snapshot") {
  const store = new RolloutStore({ sessionsDirectory });
  const files = await store.refresh({
    activeThreadIds: options.threadId ? [options.threadId] : [],
  });
  const snapshot = new MetricsEngine().snapshot(files, {
    threadId: options.threadId ?? null,
  });
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} else if (options.command === "claude-snapshot") {
  if (!options.desktopSessionId) {
    throw new Error("--desktop-session-id is required for claude-snapshot");
  }
  const { ClaudeSnapshotRuntime } = await import(
    "../integrations/claude-desktop/src/snapshot-runtime.mjs"
  );
  const claudeSessionsDirectory =
    options.claudeSessionsDirectory ??
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
    );
  const claudeProjectsDirectory =
    options.claudeProjectsDirectory ??
    path.join(os.homedir(), ".claude", "projects");
  const { ClaudeCloudSessionStore } = await import(
    "../integrations/claude-desktop/src/cloud-session-store.mjs"
  );
  // One-shot diagnostics: no persisted index, so a CLI run never writes state.
  let lastProgress = 0;
  const cloudSessionStore = new ClaudeCloudSessionStore({
    ...(options.claudeCacheDirectory ? { cacheDirectory: options.claudeCacheDirectory } : {}),
    indexPersistPath: null,
    allowPartial: options.strict !== true,
    // A one-shot run must read every cache header before it can say "missing".
    waitForIndex: true,
    onProgress: (progress) => {
      const done = progress.scannedFiles - progress.backlog;
      if (done - lastProgress < 5_000) return;
      lastProgress = done;
      process.stderr.write(`indexing Claude cache: ${done}/${progress.scannedFiles} entries\n`);
    },
  });
  const runtime = new ClaudeSnapshotRuntime({
    sessionsDirectory: claudeSessionsDirectory,
    projectsDirectory: claudeProjectsDirectory,
    cloudSessionStore,
  });
  const snapshot = await runtime.snapshot(options.desktopSessionId);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} else if (options.command === "claude-cache-inspect") {
  // Byte-level view of every cached entry for one cloud Session: structure,
  // encoding, decode strategy, and event counts. Never prints content.
  if (!options.desktopSessionId) {
    throw new Error("--desktop-session-id is required for claude-cache-inspect");
  }
  const [{ ClaudeCloudSessionStore, defaultClaudeCacheDirectory }, simpleCache, cloudEvents] =
    await Promise.all([
      import("../integrations/claude-desktop/src/cloud-session-store.mjs"),
      import("../integrations/claude-desktop/src/simple-cache.mjs"),
      import("../integrations/claude-desktop/src/cloud-events.mjs"),
    ]);
  const cacheDirectory = options.claudeCacheDirectory ?? defaultClaudeCacheDirectory();
  const store = new ClaudeCloudSessionStore({ cacheDirectory, indexPersistPath: null, waitForIndex: true });
  const variants = cloudEvents.cloudSessionIdVariants(options.desktopSessionId);
  await store.index.refresh();
  while (store.index.stats.backlog > 0) await store.index.refresh();
  const report = { cacheDirectory, variants, indexed: store.index.stats, entries: [] };
  for (const item of store.index.find()) {
    const info = cloudEvents.classifyCloudCacheKey(item.key, variants);
    if (info == null || info.kind === "session-watch") continue;
    const entry = { shape: info.shape, kind: info.kind };
    try {
      const cached = await simpleCache.readSimpleCacheEntry(item.path);
      entry.fileBytes = cached.sizeBytes;
      entry.modifiedAt = new Date(cached.modifiedMs).toISOString();
      entry.truncated = cached.truncated;
      entry.headers = cached.headers;
      entry.body = simpleCache.analyzeBody(cached.body);
      try {
        const decoded = simpleCache.decodeCacheBody(cached.body, { truncated: cached.truncated });
        const text = decoded.bytes.toString("utf8");
        const extracted = cloudEvents.extractCloudEvents(text);
        const sequences = extracted.events.map((event) => event.sequence);
        entry.decode = {
          format: decoded.format,
          partial: decoded.partial,
          strategy: decoded.strategy ?? "strict",
          walk: decoded.walk ?? (decoded.format === "gzip" ? { ...simpleCache.walkGzip(cached.body).stats, anomalies: simpleCache.walkGzip(cached.body).anomalies } : null),
          decodedBytes: decoded.bytes.length,
          bodyKind: extracted.format,
          sseFrames: extracted.frames ?? null,
          dataLines: (text.match(/^data:/gm) ?? []).length,
          usageRecords: (text.match(/"usage"/g) ?? []).length,
          events: extracted.events.length,
          withPayload: extracted.events.filter((event) => event.payload != null).length,
          sequenceRange: sequences.length ? [Math.min(...sequences), Math.max(...sequences)] : null,
          parseErrors: extracted.errors?.slice(0, 3) ?? [],
        };
      } catch (error) {
        entry.decode = { error: error.code ?? "DECODE_FAILED", detail: error.message };
      }
    } catch (error) {
      entry.error = error.code ?? error.message;
    }
    report.entries.push(entry);
  }
  await store.close();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (options.command === "inject") {
  const modulePath = new URL(
    "../integrations/codex-desktop/src/injector.mjs",
    import.meta.url,
  );
  const { runCodexInjector } = await import(modulePath);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await runCodexInjector({
    sessionsDirectory,
    cdpPort: options.cdpPort || 9334,
    signal: controller.signal,
  });
} else if (options.command === "remove") {
  const modulePath = new URL(
    "../integrations/codex-desktop/src/injector.mjs",
    import.meta.url,
  );
  const { removeCodexMeter } = await import(modulePath);
  const result = await removeCodexMeter({ cdpPort: options.cdpPort || 9334 });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (options.command === "identity") {
  const { loadOrCreateIdentity, setHandle, setSharingEnabled } = await import(
    "./core/identity.mjs"
  );
  let identity;
  if (options.setHandle != null) identity = setHandle(options.setHandle);
  else if (options.clearHandle) identity = setHandle(null);
  else identity = loadOrCreateIdentity();
  if (options.sharing != null) {
    identity = setSharingEnabled(options.sharing === "on" || options.sharing === "true");
  }
  const { privateKeyPem, ...publicFields } = identity;
  process.stdout.write(`${JSON.stringify(publicFields, null, 2)}\n`);
} else if (options.command === "profile-invite") {
  const { loadOrCreateIdentity } = await import("./core/identity.mjs");
  const { createProfileInvite } = await import("./core/registry-client.mjs");
  const result = await createProfileInvite(loadOrCreateIdentity(), {
    mode: options.mode ?? "add",
    replaceMeterId: options.replaceMeterId ?? null,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (options.command === "profile-join") {
  if (!options.inviteToken) throw new Error("--invite-token is required for profile-join");
  const { loadOrCreateIdentity, setSharingEnabled } = await import("./core/identity.mjs");
  const { joinExistingProfile, uploadUsage } = await import("./core/registry-client.mjs");
  const result = await joinExistingProfile(loadOrCreateIdentity(), {
    inviteToken: options.inviteToken,
    deviceLabel: options.deviceLabel ?? null,
  });
  let sync = "disabled";
  if (options.sharing === "on" || options.sharing === "true") {
    const identity = setSharingEnabled(true);
    await uploadUsage(identity);
    sync = "ok";
  }
  process.stdout.write(`${JSON.stringify({ ...result, sync }, null, 2)}\n`);
} else if (options.command === "profile-membership") {
  const { loadOrCreateIdentity } = await import("./core/identity.mjs");
  const { fetchProfileMembership } = await import("./core/registry-client.mjs");
  process.stdout.write(`${JSON.stringify(
    await fetchProfileMembership(loadOrCreateIdentity()),
    null,
    2,
  )}\n`);
} else if (options.command === "profile-devices") {
  const { loadOrCreateIdentity } = await import("./core/identity.mjs");
  const { fetchProfileDevices } = await import("./core/registry-client.mjs");
  process.stdout.write(`${JSON.stringify(
    await fetchProfileDevices(loadOrCreateIdentity()),
    null,
    2,
  )}\n`);
} else if (options.command === "profile-revoke" || options.command === "profile-transfer") {
  if (!options.targetMeterId) {
    throw new Error(`--target-meter-id is required for ${options.command}`);
  }
  const { loadOrCreateIdentity } = await import("./core/identity.mjs");
  const { revokeProfileDevice, transferProfileOwner } = await import(
    "./core/registry-client.mjs"
  );
  const action = options.command === "profile-transfer"
    ? transferProfileOwner
    : revokeProfileDevice;
  process.stdout.write(`${JSON.stringify(
    await action(loadOrCreateIdentity(), options.targetMeterId),
    null,
    2,
  )}\n`);
} else {
  const script = fileURLToPath(import.meta.url);
  throw new Error(
    `Unknown command \"${options.command}\". Run ${script} snapshot, claude-snapshot, claude-cache-inspect, identity, profile-invite, profile-join, profile-membership, profile-devices, profile-revoke, profile-transfer, inject, or remove.`,
  );
}
