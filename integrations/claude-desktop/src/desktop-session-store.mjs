import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runWithConcurrency, timestampToMs } from "./local-data-utils.mjs";

const UUID_SOURCE =
  "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const LOCAL_DESKTOP_SESSION_ID = new RegExp(`^local_${UUID_SOURCE}$`, "i");
const CLOUD_DESKTOP_SESSION_ID = /^session_[0-9A-Za-z]{24}$/;
const CLI_SESSION_ID = new RegExp(`^${UUID_SOURCE}$`, "i");

function safeString(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0")
    ? value
    : null;
}

export function isClaudeDesktopSessionId(value) {
  return (
    isClaudeLocalDesktopSessionId(value) || isClaudeCloudSessionId(value)
  );
}

export function isClaudeLocalDesktopSessionId(value) {
  return typeof value === "string" && LOCAL_DESKTOP_SESSION_ID.test(value);
}

export function isClaudeCloudSessionId(value) {
  return typeof value === "string" && CLOUD_DESKTOP_SESSION_ID.test(value);
}

export function isClaudeCliSessionId(value) {
  return typeof value === "string" && CLI_SESSION_ID.test(value);
}

export function parseClaudeDesktopSession(source) {
  let value;
  try {
    value =
      typeof source === "string" || Buffer.isBuffer(source)
        ? JSON.parse(String(source))
        : source;
  } catch {
    return null;
  }
  if (value == null || typeof value !== "object") return null;

  const desktopSessionId = safeString(value.sessionId);
  const cliSessionId = safeString(value.cliSessionId);
  const cwd = safeString(value.cwd);
  if (
    !isClaudeLocalDesktopSessionId(desktopSessionId) ||
    !isClaudeCliSessionId(cliSessionId) ||
    cwd == null ||
    !path.isAbsolute(cwd)
  ) {
    return null;
  }

  return {
    desktopSessionId,
    cliSessionId,
    cwd: path.normalize(cwd),
    createdAtMs: timestampToMs(value.createdAt),
    lastActivityAtMs: timestampToMs(value.lastActivityAt),
    lastFocusedAtMs: timestampToMs(value.lastFocusedAt),
    model: safeString(value.model),
    effort: safeString(value.effort),
  };
}

async function walkMetadata(directory, result) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walkMetadata(target, result);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        const fileStat = await stat(target);
        result.push({
          path: target,
          modifiedMs: fileStat.mtimeMs,
          size: fileStat.size,
        });
      }
    }),
  );
}

export class ClaudeDesktopSessionStore {
  constructor({
    sessionsDirectory,
    discoveryIntervalMs = 5_000,
    metadataFileLimit = 5_000,
    maxMetadataBytes = 1024 * 1024,
    readConcurrency = 16,
  } = {}) {
    if (!sessionsDirectory) throw new TypeError("sessionsDirectory is required");
    this.sessionsDirectory = sessionsDirectory;
    this.discoveryIntervalMs = discoveryIntervalMs;
    this.metadataFileLimit = metadataFileLimit;
    this.maxMetadataBytes = maxMetadataBytes;
    this.readConcurrency = readConcurrency;
    this.files = new Map();
    this.byDesktopSessionId = new Map();
    this.lastDiscoveryMs = 0;
    this.discoveryDirty = true;
  }

  markDiscoveryDirty() {
    this.discoveryDirty = true;
  }

  async refresh({ force = false, preferredDesktopSessionId = null } = {}) {
    const now = Date.now();
    if (
      !force &&
      !this.discoveryDirty &&
      now - this.lastDiscoveryMs < this.discoveryIntervalMs
    ) {
      return;
    }

    const discovered = [];
    try {
      await walkMetadata(this.sessionsDirectory, discovered);
    } catch (error) {
      this.discoveryDirty = true;
      throw error;
    }
    discovered.sort((left, right) => right.modifiedMs - left.modifiedMs);
    const selected = discovered.slice(0, this.metadataFileLimit);
    if (isClaudeLocalDesktopSessionId(preferredDesktopSessionId)) {
      const expectedName = `${preferredDesktopSessionId}.json`;
      for (const file of discovered) {
        if (path.basename(file.path) === expectedName && !selected.includes(file)) {
          selected.push(file);
        }
      }
    }

    const selectedPaths = new Set(selected.map((file) => file.path));
    for (const filePath of this.files.keys()) {
      if (!selectedPaths.has(filePath)) this.files.delete(filePath);
    }
    await runWithConcurrency(selected, this.readConcurrency, async (file) => {
      const prior = this.files.get(file.path);
      if (prior?.modifiedMs === file.modifiedMs && prior?.size === file.size) {
        return;
      }

      let session = null;
      if (file.size <= this.maxMetadataBytes) {
        const source = await readFile(file.path);
        if (source.byteLength <= this.maxMetadataBytes) {
          session = parseClaudeDesktopSession(source);
        }
      }
      this.files.set(file.path, { ...file, session });
    });

    this.byDesktopSessionId.clear();
    for (const file of this.files.values()) {
      const desktopSessionId = file.session?.desktopSessionId;
      if (!desktopSessionId) continue;
      const matches = this.byDesktopSessionId.get(desktopSessionId) ?? [];
      matches.push(file.session);
      this.byDesktopSessionId.set(desktopSessionId, matches);
    }
    this.lastDiscoveryMs = now;
    this.discoveryDirty = false;
  }

  async resolve(desktopSessionId) {
    if (!isClaudeDesktopSessionId(desktopSessionId)) {
      return {
        status: "unbound",
        desktopSessionId,
        reason: "invalid-desktop-session-id",
      };
    }

    await this.refresh({ preferredDesktopSessionId: desktopSessionId });
    let matches = this.byDesktopSessionId.get(desktopSessionId) ?? [];
    if (matches.length === 0) {
      await this.refresh({ force: true, preferredDesktopSessionId: desktopSessionId });
      matches = this.byDesktopSessionId.get(desktopSessionId) ?? [];
    }
    if (matches.length !== 1) {
      return {
        status: "unbound",
        desktopSessionId,
        reason:
          matches.length === 0
            ? "session-metadata-not-found"
            : "ambiguous-session-metadata",
      };
    }
    return { status: "resolved", ...matches[0] };
  }
}
