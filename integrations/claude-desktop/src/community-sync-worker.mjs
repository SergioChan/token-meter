import { parentPort, workerData } from "node:worker_threads";
import {
  loadOrCreateIdentity,
} from "../../../src/core/identity.mjs";
import {
  claimHandle,
  registryEnabled,
  uploadUsage,
} from "../../../src/core/registry-client.mjs";

async function run() {
  if (!registryEnabled()) return { ok: true, skipped: "registry-disabled" };
  const identity = loadOrCreateIdentity();
  if (identity.sharing?.enabled !== true) {
    return { ok: true, skipped: "sharing-disabled" };
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
