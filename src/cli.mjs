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
  const runtime = new ClaudeSnapshotRuntime({
    sessionsDirectory: claudeSessionsDirectory,
    projectsDirectory: claudeProjectsDirectory,
  });
  const snapshot = await runtime.snapshot(options.desktopSessionId);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
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
    `Unknown command \"${options.command}\". Run ${script} snapshot, claude-snapshot, identity, profile-invite, profile-join, profile-membership, profile-devices, profile-revoke, profile-transfer, inject, or remove.`,
  );
}
