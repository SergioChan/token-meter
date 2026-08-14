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
const server = new RegistryServer({
  store: createRegistryStore({
    databaseUrl: process.env.DATABASE_URL,
    dataFile,
  }),
  webDir: path.join(root, "web"),
  downloadFile: path.join(root, "dist", `token-widget-${version}-macos.zip`),
  dmgFile: path.join(root, "dist", `TokenWidget-${version}.dmg`),
  latestVersion: version,
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
