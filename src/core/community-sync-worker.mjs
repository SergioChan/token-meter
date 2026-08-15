import { parentPort, workerData } from "node:worker_threads";
import {
  clearProfileMembership,
  loadOrCreateIdentity,
  setProfileMembership,
  setPendingWithdraw,
} from "./identity.mjs";
import {
  claimHandle,
  fetchProfileMembership,
  registryEnabled,
  uploadUsage,
  withdrawUsage,
} from "./registry-client.mjs";

async function run() {
  if (!registryEnabled()) return { ok: true, skipped: "registry-disabled" };
  let identity = loadOrCreateIdentity();
  if (identity.sharing?.enabled !== true) {
    // A withdrawal the registry never confirmed keeps retrying here until
    // the server-side wipe actually lands.
    if (identity.sharing?.pendingWithdraw === true) {
      await withdrawUsage(identity);
      setPendingWithdraw(false);
      return { ok: true, reason: "withdraw-retry" };
    }
    return { ok: true, skipped: "sharing-disabled" };
  }
  try {
    const membership = await fetchProfileMembership(identity);
    if (membership.member) {
      identity = setProfileMembership({
        ...membership,
        lastConfirmedAtMs: Date.now(),
      });
    } else if (identity.profile) {
      clearProfileMembership();
      return { ok: true, skipped: "device-revoked" };
    }
  } catch (error) {
    // A pre-v0.3 registry has no membership route. Other failures are left to
    // the signed usage upload below so the worker still reports connectivity.
    void error;
  }
  if (identity.handle && !identity.handleClaimed) {
    await claimHandle(identity).catch(() => {});
  }
  await uploadUsage(identity);
  return { ok: true, reason: workerData?.reason ?? "unspecified" };
}

try {
  parentPort?.postMessage(await run());
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
