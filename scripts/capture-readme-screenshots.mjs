#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectVerifiedCodexRenderer } from "../src/codex/injector.mjs";

const cdpPort = Number(process.env.CODEX_CDP_PORT || 9334);
const outputDirectory = path.resolve("docs/assets");

const normalSnapshot = {
  status: "bound",
  binding: { exact: true, source: "active-sidebar-row" },
  sessionId: "11111111-2222-4333-8444-555555555555",
  childAgentCount: 3,
  session: { totalTokens: 2_483_920, lastHourTokens: 418_540 },
  turn: { tokens: 96_240 },
  account: { lastHourTokens: 1_854_980 },
  rate: {
    tokensPerMinute: 186_420,
    intensity: 0.64,
    band: "yellow",
    scaleTokensPerMinute: 291_281,
  },
  anomaly: {
    level: "normal",
    baseline: {
      medianTokensPerMinute: 92_300,
      p95TokensPerMinute: 291_281,
    },
  },
};

const alertSnapshot = {
  ...normalSnapshot,
  session: { totalTokens: 2_812_640, lastHourTokens: 747_260 },
  turn: { tokens: 424_960 },
  rate: {
    tokensPerMinute: 1_240_000,
    intensity: 0.94,
    band: "red",
    scaleTokensPerMinute: 1_319_149,
  },
  anomaly: {
    level: "warning",
    ratio: 8.7,
    threshold: 425_000,
    baseline: {
      sampleCount: 42,
      medianTokensPerMinute: 142_000,
      p95TokensPerMinute: 610_000,
    },
  },
};

async function stageSnapshot(client, snapshot) {
  await client.evaluate(`(() => {
    const meter = window.__tokenMeter;
    if (!meter) throw new Error("Token Meter runtime is not mounted");
    window.__tokenMeterCaptureUpdate ??= meter.update;
    meter.update = window.__tokenMeterCaptureUpdate;
    meter.update(${JSON.stringify(snapshot)});
    meter.update = () => {};
    document.querySelector("#token-meter-host")
      .shadowRoot.querySelector(".meter-card")
      .classList.add("expanded");
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 700));
  return client.evaluate(`(() => {
    const card = document.querySelector("#token-meter-host")
      .shadowRoot.querySelector(".meter-card");
    const rect = card.getBoundingClientRect();
    let backdrop = document.querySelector("#token-meter-capture-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.id = "token-meter-capture-backdrop";
      document.documentElement.append(backdrop);
    }
    Object.assign(backdrop.style, {
      position: "fixed",
      left: (rect.left - 14) + "px",
      top: (rect.top - 14) + "px",
      width: (rect.width + 28) + "px",
      height: (rect.height + 28) + "px",
      borderRadius: "22px",
      background: "#0f1110",
      zIndex: "2147482999",
      pointerEvents: "none",
    });
    return {
      x: rect.left - 14,
      y: rect.top - 14,
      width: rect.width + 28,
      height: rect.height + 28,
    };
  })()`);
}

async function capture(client, fileName, snapshot) {
  const clip = await stageSnapshot(client, snapshot);
  const response = await client.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { ...clip, scale: 2 },
  });
  await writeFile(
    path.join(outputDirectory, fileName),
    Buffer.from(response.data, "base64"),
  );
}

await mkdir(outputDirectory, { recursive: true });
const { client } = await connectVerifiedCodexRenderer({ cdpPort });
try {
  await client.call("Page.enable");
  await capture(client, "token-meter-live.png", normalSnapshot);
  await capture(client, "token-meter-alert.png", alertSnapshot);
} finally {
  await client
    .evaluate(`(() => {
      if (window.__tokenMeterCaptureUpdate && window.__tokenMeter) {
        window.__tokenMeter.update = window.__tokenMeterCaptureUpdate;
        delete window.__tokenMeterCaptureUpdate;
      }
      document.querySelector("#token-meter-capture-backdrop")?.remove();
    })()`)
    .catch(() => {});
  client.close();
}

process.stdout.write(`Wrote screenshots to ${outputDirectory}\n`);
