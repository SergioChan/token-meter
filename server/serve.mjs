#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RegistryServer } from "./registry-server.mjs";
import { createRegistryStore } from "./registry-store.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const port = Number(process.env.TOKEN_METER_REGISTRY_PORT || 8787);
const host = process.env.TOKEN_METER_REGISTRY_HOST || "127.0.0.1";
const dataFile =
  process.env.TOKEN_METER_REGISTRY_DATA ||
  path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "Token Meter",
    "Registry",
    "registry.json",
  );
// Production containers carry no DMG. A release is published to installed
// widgets by describing it in the environment: version + digest + size feed
// /api/v1/latest, and the download route redirects to the immutable release
// asset (TOKEN_METER_LATEST_URL). Absent these, the local dist/ files serve.
const latestRelease =
  process.env.TOKEN_METER_LATEST_VERSION && process.env.TOKEN_METER_LATEST_SHA256
    ? {
        version: process.env.TOKEN_METER_LATEST_VERSION,
        path: "/download/token-widget.dmg",
        sha256: process.env.TOKEN_METER_LATEST_SHA256,
        size: Number(process.env.TOKEN_METER_LATEST_SIZE) || null,
      }
    : null;

const server = new RegistryServer({
  store: createRegistryStore({
    databaseUrl: process.env.DATABASE_URL,
    dataFile,
  }),
  webDir: path.join(root, "web"),
  downloadFile: path.join(root, "dist", `token-widget-${version}-macos.zip`),
  dmgFile: path.join(root, "dist", `TokenWidget-${version}.dmg`),
  latestVersion: version,
  latestRelease,
  dmgRedirectUrl: process.env.TOKEN_METER_LATEST_URL || null,
  host,
});
await server.start(port);
console.log(`registry listening on http://${host}:${server.port}`);

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
