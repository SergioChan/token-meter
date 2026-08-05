import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const ROLLOUT_FILE = /^rollout-.*-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;

function timestampToMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBreakdown(value) {
  if (value == null || typeof value !== "object") return null;
  const totalTokens = Number(value.total_tokens ?? value.totalTokens);
  if (!Number.isFinite(totalTokens)) return null;
  return {
    totalTokens,
    inputTokens: Number(value.input_tokens ?? value.inputTokens) || 0,
    cachedInputTokens: Number(value.cached_input_tokens ?? value.cachedInputTokens) || 0,
    outputTokens: Number(value.output_tokens ?? value.outputTokens) || 0,
    reasoningOutputTokens:
      Number(value.reasoning_output_tokens ?? value.reasoningOutputTokens) || 0,
  };
}

export function parseRolloutLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }

  const timestampMs = timestampToMs(value.timestamp);
  if (value.type === "session_meta") {
    const payload = value.payload ?? {};
    return {
      kind: "meta",
      id: payload.id ?? null,
      sessionId: payload.session_id ?? payload.id ?? null,
      source: payload.source ?? null,
      threadSource: payload.thread_source ?? null,
      originator: payload.originator ?? null,
      cwd: payload.cwd ?? null,
      timestampMs,
    };
  }

  if (value.type !== "event_msg") return null;
  const payload = value.payload ?? {};
  if (payload.type === "token_count") {
    const info = payload.info ?? {};
    const total = normalizeBreakdown(info.total_token_usage ?? info.totalTokenUsage);
    const last = normalizeBreakdown(info.last_token_usage ?? info.lastTokenUsage);
    if (total == null || timestampMs == null) return null;
    return {
      kind: "usage",
      timestampMs,
      total,
      last,
      contextWindow:
        Number(info.model_context_window ?? info.modelContextWindow) || null,
    };
  }

  if (payload.type === "user_message" && timestampMs != null) {
    return { kind: "userMessage", timestampMs };
  }
  if (payload.type === "task_complete" && timestampMs != null) {
    return { kind: "turnComplete", timestampMs };
  }
  if (payload.type === "turn_aborted" && timestampMs != null) {
    return { kind: "turnAborted", timestampMs };
  }
  return null;
}

async function defaultReadRange(filePath, { length, position }) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function createFileState(filePath, discoveredId, modifiedMs) {
  return {
    path: filePath,
    discoveredId,
    modifiedMs,
    offset: 0,
    remainder: "",
    decoder: new StringDecoder("utf8"),
    skippingOversizedLine: false,
    meta: null,
    usage: [],
    userMessages: [],
    turnCompletions: [],
    turnAborts: [],
  };
}

async function walk(directory, result) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, result);
        return;
      }
      const match = entry.name.match(ROLLOUT_FILE);
      if (!entry.isFile() || match == null) return;
      const fileStat = await stat(fullPath);
      result.push({
        path: fullPath,
        discoveredId: match[1],
        modifiedMs: fileStat.mtimeMs,
        size: fileStat.size,
      });
    }),
  );
}

async function runWithConcurrency(items, concurrency, operation) {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++];
        await operation(item);
      }
    },
  );
  await Promise.all(workers);
}

export class RolloutStore {
  constructor({
    sessionsDirectory,
    historyFileLimit = 100,
    discoveryIntervalMs = 10_000,
    readChunkBytes = 1024 * 1024,
    maxLineBytes = 4 * 1024 * 1024,
    readRange = defaultReadRange,
    readConcurrency = 16,
  }) {
    if (!sessionsDirectory) throw new TypeError("sessionsDirectory is required");
    this.sessionsDirectory = sessionsDirectory;
    this.historyFileLimit = historyFileLimit;
    this.discoveryIntervalMs = discoveryIntervalMs;
    this.readChunkBytes = readChunkBytes;
    this.maxLineBytes = maxLineBytes;
    this.readRange = readRange;
    this.readConcurrency = readConcurrency;
    this.files = new Map();
    this.lastDiscoveryMs = 0;
  }

  async discover({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this.lastDiscoveryMs < this.discoveryIntervalMs) return;
    const discovered = [];
    await walk(this.sessionsDirectory, discovered);
    for (const file of discovered) {
      const existing = this.files.get(file.path);
      if (existing == null) {
        this.files.set(
          file.path,
          createFileState(file.path, file.discoveredId, file.modifiedMs),
        );
      } else {
        existing.modifiedMs = file.modifiedMs;
      }
    }
    this.lastDiscoveryMs = now;
  }

  async refresh({ activeThreadIds = [] } = {}) {
    await this.discover();
    const activeIds = new Set(activeThreadIds.filter(Boolean));
    const discoveredIds = new Set(
      [...this.files.values()].map((file) => file.discoveredId),
    );
    if ([...activeIds].some((id) => !discoveredIds.has(id))) {
      await this.discover({ force: true });
    }
    const files = [...this.files.values()].sort(
      (left, right) => right.modifiedMs - left.modifiedMs,
    );
    const selected = new Set(files.slice(0, this.historyFileLimit));
    const exactActiveFiles = files.filter((file) => activeIds.has(file.discoveredId));
    const activeDirectories = new Set(
      exactActiveFiles.map((file) => path.dirname(file.path)),
    );
    const activeCandidates = files.filter((file) =>
      activeDirectories.has(path.dirname(file.path)),
    );
    await runWithConcurrency(
      activeCandidates,
      this.readConcurrency,
      (file) => this.#readMetadata(file),
    );
    const activeSessionIds = new Set(
      exactActiveFiles.map((file) => file.meta?.sessionId).filter(Boolean),
    );
    for (const file of files) {
      if (
        activeIds.has(file.discoveredId) ||
        activeSessionIds.has(file.meta?.sessionId)
      ) {
        selected.add(file);
      }
    }

    await runWithConcurrency(
      [...selected],
      this.readConcurrency,
      (file) => this.#readAppended(file),
    );

    return [...selected].filter((file) => file.meta != null);
  }

  async #readMetadata(file) {
    if (file.meta != null) return;
    const fileStat = await stat(file.path);
    const decoder = new StringDecoder("utf8");
    let position = 0;
    let source = "";
    while (position < fileStat.size && Buffer.byteLength(source, "utf8") <= this.maxLineBytes) {
      const length = Math.min(this.readChunkBytes, fileStat.size - position);
      const buffer = await this.readRange(file.path, { length, position });
      if (buffer.length === 0) break;
      position += buffer.length;
      source += decoder.write(buffer);
      const newline = source.indexOf("\n");
      if (newline !== -1) {
        const event = parseRolloutLine(source.slice(0, newline));
        if (event?.kind === "meta") file.meta = event;
        return;
      }
    }
  }

  async #readAppended(file) {
    const fileStat = await stat(file.path);
    if (fileStat.size < file.offset) {
      file.offset = 0;
      file.remainder = "";
      file.decoder = new StringDecoder("utf8");
      file.skippingOversizedLine = false;
      file.meta = null;
      file.usage = [];
      file.userMessages = [];
      file.turnCompletions = [];
      file.turnAborts = [];
    }
    if (fileStat.size === file.offset) {
      file.modifiedMs = fileStat.mtimeMs;
      return;
    }

    while (file.offset < fileStat.size) {
      const length = Math.min(
        this.readChunkBytes,
        fileStat.size - file.offset,
      );
      const buffer = await this.readRange(file.path, {
        length,
        position: file.offset,
      });
      if (buffer.length === 0) break;
      file.offset += buffer.length;
      this.#consumeText(file, file.decoder.write(buffer));
    }
    file.modifiedMs = fileStat.mtimeMs;
  }

  #consumeText(file, decoded) {
    let text = decoded;
    if (file.skippingOversizedLine) {
      const newline = text.indexOf("\n");
      if (newline === -1) return;
      text = text.slice(newline + 1);
      file.skippingOversizedLine = false;
    }

    const source = file.remainder + text;
    const lines = source.split("\n");
    file.remainder = lines.pop() ?? "";
    for (const line of lines) this.#apply(file, parseRolloutLine(line));
    if (Buffer.byteLength(file.remainder, "utf8") > this.maxLineBytes) {
      file.remainder = "";
      file.skippingOversizedLine = true;
    }
  }

  #apply(file, event) {
    if (event == null) return;
    if (event.kind === "meta") file.meta = event;
    else if (event.kind === "usage") file.usage.push(event);
    else if (event.kind === "userMessage") file.userMessages.push(event.timestampMs);
    else if (event.kind === "turnComplete") {
      file.turnCompletions.push(event.timestampMs);
    } else if (event.kind === "turnAborted") {
      file.turnAborts.push(event.timestampMs);
    }
  }
}

export function isRootUserRollout(file) {
  return file.meta?.threadSource === "user" || file.meta?.source === "vscode";
}
