import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  isClaudeCliSessionId,
  isClaudeDesktopSessionId,
} from "./desktop-session-store.mjs";

const TERMINAL_STOP_REASONS = new Set([
  "end_turn",
  "refusal",
  "stop_sequence",
]);

function timestampToMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function normalizeClaudeUsage(value) {
  if (value == null || typeof value !== "object") return null;
  const directInputTokens = tokenCount(value.input_tokens);
  const cacheCreationInputTokens = tokenCount(value.cache_creation_input_tokens);
  const cachedInputTokens = tokenCount(value.cache_read_input_tokens);
  const outputTokens = tokenCount(value.output_tokens);
  const inputTokens =
    directInputTokens + cacheCreationInputTokens + cachedInputTokens;
  const totalTokens = inputTokens + outputTokens;
  if (totalTokens === 0) return null;

  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens: tokenCount(
      value.output_tokens_details?.thinking_tokens,
    ),
  };
}

function isRootUserMessage(value) {
  if (
    value.isSidechain === true ||
    value.isMeta === true ||
    value.isCompactSummary === true ||
    value.isVisibleInTranscriptOnly === true ||
    value.sourceToolUseID != null ||
    value.sourceToolAssistantUUID != null
  ) {
    return false;
  }

  const content = value.message?.content;
  if (!Array.isArray(content)) return typeof content === "string";
  return content.some(
    (block) =>
      block == null ||
      typeof block !== "object" ||
      block.type !== "tool_result",
  );
}

export function parseClaudeTranscriptLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const timestampMs = timestampToMs(value.timestamp);
  if (timestampMs == null) return null;

  if (value.type === "user" && value.isCompactSummary === true) {
    return { kind: "contextCompacted", timestampMs };
  }
  if (value.type === "user" && isRootUserMessage(value)) {
    return { kind: "userMessage", timestampMs };
  }
  if (value.type !== "assistant") return null;

  const responseId =
    typeof value.message?.id === "string" && value.message.id.length > 0
      ? value.message.id
      : null;
  if (responseId == null) return null;
  const aborted =
    value.isAbortedMidStream === true || value.isApiErrorMessage === true;
  const stopReason = value.message.stop_reason ?? null;
  const terminal = aborted
    ? "aborted"
    : TERMINAL_STOP_REASONS.has(stopReason)
      ? "complete"
      : null;
  const usage = normalizeClaudeUsage(value.message?.usage);
  if (usage == null) {
    return terminal == null
      ? null
      : { kind: "assistantTerminal", responseId, timestampMs, terminal };
  }
  return {
    kind: "assistantUsage",
    responseId,
    requestId:
      typeof value.requestId === "string" && value.requestId.length > 0
        ? value.requestId
        : null,
    timestampMs,
    usage,
    terminal,
  };
}

export function encodeClaudeProjectDirectory(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new TypeError("cwd must be an absolute path");
  }
  return path.normalize(cwd).replace(/[^a-zA-Z0-9]/g, "-");
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

function createFileState(filePath, { isRoot, modifiedMs }) {
  return {
    path: filePath,
    isRoot,
    modifiedMs,
    offset: 0,
    remainder: "",
    decoder: new StringDecoder("utf8"),
    skippingOversizedLine: false,
    skippedOversizedLineCount: 0,
    responses: new Map(),
    terminals: new Map(),
    userMessages: new Set(),
    contextCompactions: new Set(),
  };
}

async function walkTranscriptFiles(directory, result) {
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
        await walkTranscriptFiles(target, result);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        entry.name !== "journal.jsonl"
      ) {
        const fileStat = await stat(target);
        result.push({
          path: target,
          isRoot: false,
          modifiedMs: fileStat.mtimeMs,
          size: fileStat.size,
        });
      }
    }),
  );
}

async function runWithConcurrency(items, concurrency, operation) {
  let index = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (index < items.length) await operation(items[index++]);
    },
  );
  await Promise.all(workers);
}

function addBreakdown(target, source) {
  target.totalTokens += source.totalTokens;
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.cacheCreationInputTokens += source.cacheCreationInputTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningOutputTokens += source.reasoningOutputTokens;
  return { ...target };
}

function emptyBreakdown() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function earliestEventTimestamp(responses, userMessages) {
  let earliest = Number.POSITIVE_INFINITY;
  for (const event of responses) earliest = Math.min(earliest, event.timestampMs);
  for (const timestampMs of userMessages) earliest = Math.min(earliest, timestampMs);
  return earliest;
}

export class ClaudeTranscriptStore {
  constructor({
    projectsDirectory,
    discoveryIntervalMs = 5_000,
    readChunkBytes = 1024 * 1024,
    maxLineBytes = 4 * 1024 * 1024,
    maxTranscriptFiles = 2_000,
    readConcurrency = 8,
    readRange = defaultReadRange,
  } = {}) {
    if (!projectsDirectory) throw new TypeError("projectsDirectory is required");
    this.projectsDirectory = projectsDirectory;
    this.discoveryIntervalMs = discoveryIntervalMs;
    this.readChunkBytes = readChunkBytes;
    this.maxLineBytes = maxLineBytes;
    this.maxTranscriptFiles = maxTranscriptFiles;
    this.readConcurrency = readConcurrency;
    this.readRange = readRange;
    this.activeSessionKey = null;
    this.activeSession = null;
    this.projectDirectory = null;
    this.rootTranscriptPath = null;
    this.files = new Map();
    this.lastDiscoveryMs = 0;
    this.discoveryDirty = true;
  }

  markDiscoveryDirty() {
    this.discoveryDirty = true;
  }

  async refresh({ session, force = false } = {}) {
    this.#bindSession(session);
    await this.#discover({ force });
    const root = this.files.get(this.rootTranscriptPath);
    if (root == null) return [];

    await runWithConcurrency(
      [...this.files.values()],
      this.readConcurrency,
      (file) => this.#readAppended(file),
    );
    return this.#buildMetricFiles();
  }

  #bindSession(session) {
    if (
      session?.status !== "resolved" ||
      !isClaudeDesktopSessionId(session.desktopSessionId) ||
      !isClaudeCliSessionId(session.cliSessionId) ||
      typeof session.cwd !== "string" ||
      !path.isAbsolute(session.cwd)
    ) {
      throw new TypeError("a resolved Claude Desktop session is required");
    }
    const key = `${session.desktopSessionId}:${session.cliSessionId}:${session.cwd}`;
    if (key === this.activeSessionKey) {
      this.activeSession = session;
      return;
    }

    this.activeSessionKey = key;
    this.activeSession = session;
    this.projectDirectory = path.join(
      this.projectsDirectory,
      encodeClaudeProjectDirectory(session.cwd),
    );
    this.rootTranscriptPath = path.join(
      this.projectDirectory,
      `${session.cliSessionId}.jsonl`,
    );
    this.files.clear();
    this.lastDiscoveryMs = 0;
    this.discoveryDirty = true;
  }

  async #discover({ force = false } = {}) {
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
      const rootStat = await stat(this.rootTranscriptPath);
      if (rootStat.isFile()) {
        discovered.push({
          path: this.rootTranscriptPath,
          isRoot: true,
          modifiedMs: rootStat.mtimeMs,
          size: rootStat.size,
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await walkTranscriptFiles(
      path.join(
        this.projectDirectory,
        this.activeSession.cliSessionId,
        "subagents",
      ),
      discovered,
    );
    if (discovered.length > this.maxTranscriptFiles) {
      throw new Error(
        `Claude session has ${discovered.length} transcript files; limit is ${this.maxTranscriptFiles}`,
      );
    }

    const discoveredPaths = new Set(discovered.map((file) => file.path));
    for (const filePath of this.files.keys()) {
      if (!discoveredPaths.has(filePath)) this.files.delete(filePath);
    }
    for (const file of discovered) {
      const existing = this.files.get(file.path);
      if (existing == null) {
        this.files.set(file.path, createFileState(file.path, file));
      } else {
        existing.modifiedMs = file.modifiedMs;
      }
    }
    this.lastDiscoveryMs = now;
    this.discoveryDirty = false;
  }

  async #readAppended(file) {
    let fileStat;
    try {
      fileStat = await stat(file.path);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (fileStat.size < file.offset) this.#resetFile(file);
    if (fileStat.size === file.offset) {
      file.modifiedMs = fileStat.mtimeMs;
      return;
    }

    while (file.offset < fileStat.size) {
      const length = Math.min(this.readChunkBytes, fileStat.size - file.offset);
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

  #resetFile(file) {
    file.offset = 0;
    file.remainder = "";
    file.decoder = new StringDecoder("utf8");
    file.skippingOversizedLine = false;
    file.skippedOversizedLineCount = 0;
    file.responses.clear();
    file.terminals.clear();
    file.userMessages.clear();
    file.contextCompactions.clear();
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
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        file.skippedOversizedLineCount += 1;
      } else {
        this.#apply(file, parseClaudeTranscriptLine(line));
      }
    }
    if (Buffer.byteLength(file.remainder, "utf8") > this.maxLineBytes) {
      file.remainder = "";
      file.skippingOversizedLine = true;
      file.skippedOversizedLineCount += 1;
    }
  }

  #apply(file, event) {
    if (event == null) return;
    if (event.kind === "assistantUsage") {
      file.responses.set(event.responseId, event);
      if (event.terminal != null) file.terminals.set(event.responseId, event);
    } else if (event.kind === "assistantTerminal") {
      file.terminals.set(event.responseId, event);
    } else if (file.isRoot && event.kind === "userMessage") {
      file.userMessages.add(event.timestampMs);
    } else if (file.isRoot && event.kind === "contextCompacted") {
      file.contextCompactions.add(event.timestampMs);
    }
  }

  #buildMetricFiles() {
    const claimedResponseIds = new Set();
    const orderedStates = [...this.files.values()].sort((left, right) => {
      if (left.isRoot !== right.isRoot) return left.isRoot ? -1 : 1;
      return left.path.localeCompare(right.path);
    });

    return orderedStates.map((file, index) => {
      const responses = [...file.responses.values()]
        .filter((event) => {
          if (claimedResponseIds.has(event.responseId)) return false;
          claimedResponseIds.add(event.responseId);
          return true;
        })
        .sort(
          (left, right) =>
            left.timestampMs - right.timestampMs ||
            left.responseId.localeCompare(right.responseId),
        );
      const cumulative = emptyBreakdown();
      const usage = responses.map((event) => ({
        kind: "usage",
        timestampMs: event.timestampMs,
        total: addBreakdown(cumulative, event.usage),
        last: null,
        contextTokens: file.isRoot ? event.usage.inputTokens : null,
        contextWindow: null,
      }));
      const earliestTimestampMs = earliestEventTimestamp(
        responses,
        file.userMessages,
      );
      const id = file.isRoot
        ? this.activeSession.desktopSessionId
        : `${this.activeSession.desktopSessionId}:agent:${index}`;

      return {
        path: file.path,
        discoveredId: id,
        modifiedMs: file.modifiedMs,
        meta: {
          id,
          sessionId: this.activeSession.desktopSessionId,
          source: "claude-desktop",
          threadSource: file.isRoot ? "user" : "subagent",
          originator: "claude-code",
          cwd: this.activeSession.cwd,
          timestampMs:
            file.isRoot && this.activeSession.createdAtMs != null
              ? this.activeSession.createdAtMs
              : Number.isFinite(earliestTimestampMs)
                ? earliestTimestampMs
                : null,
        },
        usage,
        userMessages: file.isRoot
          ? [...file.userMessages].sort((left, right) => left - right)
          : [],
        turnCompletions: file.isRoot
          ? [...file.terminals.values()]
              .filter((event) => event.terminal === "complete")
              .map((event) => event.timestampMs)
              .sort((left, right) => left - right)
          : [],
        turnAborts: file.isRoot
          ? [...file.terminals.values()]
              .filter((event) => event.terminal === "aborted")
              .map((event) => event.timestampMs)
              .sort((left, right) => left - right)
          : [],
        contextCompactions: file.isRoot
          ? [...file.contextCompactions].sort((left, right) => left - right)
          : [],
        diagnostics: {
          skippedOversizedLineCount: file.skippedOversizedLineCount,
        },
      };
    });
  }
}
