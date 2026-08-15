import { Worker } from "node:worker_threads";

const defaultWorkerUrl = new URL("./community-sync-worker.mjs", import.meta.url);

export function runCommunitySyncWorker(
  reason,
  {
    workerFactory = (url, options) => new Worker(url, options),
    workerUrl = defaultWorkerUrl,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const worker = workerFactory(workerUrl, { workerData: { reason } });
    worker.unref?.();
    let settled = false;
    const finish = (error, result = null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    worker.once("message", (message) => {
      if (message?.ok === true) finish(null, message);
      else finish(new Error(message?.error || "community sync failed"));
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (code !== 0) finish(new Error(`community sync worker exited with ${code}`));
      else finish(new Error("community sync worker exited without a result"));
    });
  });
}
