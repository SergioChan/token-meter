#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { ClaudeSnapshotRuntime } from "./snapshot-runtime.mjs";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--sessions-dir") options.sessionsDirectory = argv[++index];
    else if (value === "--projects-dir") options.projectsDirectory = argv[++index];
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

function usage() {
  return `Usage: overlay-bridge.mjs [--sessions-dir PATH] [--projects-dir PATH]\n\n` +
    `Read newline-delimited snapshot requests from stdin and write one numerical ` +
    `snapshot response per line.\n`;
}

async function writeLine(value) {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) {
    await once(process.stdout, "drain");
  }
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
  process.exit(0);
}

const runtime = new ClaudeSnapshotRuntime({
  sessionsDirectory:
    options.sessionsDirectory ??
    path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude-code-sessions",
    ),
  projectsDirectory:
    options.projectsDirectory ?? path.join(os.homedir(), ".claude", "projects"),
});
const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
  terminal: false,
});

for await (const line of input) {
  if (line.trim().length === 0) continue;
  let requestId = null;
  try {
    const request = JSON.parse(line);
    requestId = request?.requestId ?? null;
    if (typeof request?.desktopSessionId !== "string") {
      throw new TypeError("desktopSessionId must be a string");
    }
    const snapshot = await runtime.snapshot(request.desktopSessionId);
    await writeLine({ requestId, snapshot });
  } catch (error) {
    await writeLine({
      requestId,
      error: {
        code: "snapshot-failed",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
