import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";

const CACHE_VERSION = 1;
const MS_PER_DAY = 86_400_000;
const JSONL_CHUNK_BYTES = 1024 * 1024;
const MAX_JSONL_LINE_CHARS = 8 * 1024 * 1024;

export function defaultSourceRoots() {
  const home = homedir();
  return {
    claudeProjectsDir: join(home, ".claude", "projects"),
    codexSessionsDir: join(home, ".codex", "sessions"),
    clineTaskDirs: ["Code", "Cursor", "VSCodium"].map((app) =>
      join(
        home,
        "Library",
        "Application Support",
        app,
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "tasks",
      ),
    ),
  };
}

export function defaultCacheFile() {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "Token Meter",
    "State",
    "usage-history-cache.json",
  );
}

function localDateKey(ms) {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyBucket() {
  return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0 };
}

function addEvent(summary, tsMs, tokens) {
  const key = localDateKey(tsMs);
  const bucket = (summary.days[key] ??= emptyBucket());
  bucket.total += tokens.total;
  bucket.input += tokens.input;
  bucket.output += tokens.output;
  bucket.cacheRead += tokens.cacheRead;
  bucket.cacheWrite += tokens.cacheWrite;
  bucket.events += 1;
  summary.hours[new Date(tsMs).getHours()] += tokens.total;
  summary.totalTokens += tokens.total;
  summary.events += 1;
  summary.firstMs = summary.firstMs == null ? tsMs : Math.min(summary.firstMs, tsMs);
  summary.lastMs = summary.lastMs == null ? tsMs : Math.max(summary.lastMs, tsMs);
}

function newSummary(platform) {
  return {
    platform,
    days: {},
    hours: Array(24).fill(0),
    totalTokens: 0,
    events: 0,
    firstMs: null,
    lastMs: null,
    sidechain: false,
  };
}

// Iterate large JSONL files without ever materializing the entire transcript.
// Content-bearing rows can be very large, while numerical usage rows are
// small. Oversized individual rows are discarded until the next newline so a
// single tool payload cannot exhaust the dashboard or community sync process.
function forEachJsonlLine(filePath, visit) {
  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(JSONL_CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let droppingOversizedLine = false;

  const consume = (text) => {
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      if (newline < 0) break;
      const segment = text.slice(start, newline);
      if (droppingOversizedLine) {
        droppingOversizedLine = false;
      } else {
        const line = carry + segment;
        if (line.length <= MAX_JSONL_LINE_CHARS) {
          visit(line.endsWith("\r") ? line.slice(0, -1) : line);
        }
      }
      carry = "";
      start = newline + 1;
    }

    const tail = text.slice(start);
    if (droppingOversizedLine || tail.length === 0) return;
    if (carry.length + tail.length > MAX_JSONL_LINE_CHARS) {
      carry = "";
      droppingOversizedLine = true;
      return;
    }
    carry += tail;
  };

  try {
    while (true) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        null,
      );
      if (bytesRead === 0) break;
      consume(decoder.write(buffer.subarray(0, bytesRead)));
    }
    consume(decoder.end());
    if (!droppingOversizedLine && carry.length > 0) {
      visit(carry.endsWith("\r") ? carry.slice(0, -1) : carry);
    }
  } finally {
    closeSync(descriptor);
  }
}

function parseClaudeTranscript(filePath) {
  const summary = newSummary("claudeCode");
  let sawPrimary = false;
  forEachJsonlLine(filePath, (line) => {
    if (line.length === 0) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    if (value?.isSidechain === false) sawPrimary = true;
    const usage = value?.message?.usage;
    const tsMs = Date.parse(value?.timestamp ?? "");
    if (usage == null || Number.isNaN(tsMs)) return;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    addEvent(summary, tsMs, {
      total: input + output + cacheWrite + cacheRead,
      input,
      output,
      cacheRead,
      cacheWrite,
    });
  });
  summary.sidechain = !sawPrimary && summary.events > 0;
  return summary;
}

function parseCodexRollout(filePath) {
  const summary = newSummary("codex");
  forEachJsonlLine(filePath, (line) => {
    if (line.length === 0) return;
    if (!line.includes('"token_count"')) return;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const info = value?.payload?.type === "token_count" ? value.payload.info : null;
    const last = info?.last_token_usage;
    const tsMs = Date.parse(value?.timestamp ?? "");
    if (last == null || Number.isNaN(tsMs)) return;
    const cacheRead = last.cached_input_tokens ?? 0;
    const rawInput = last.input_tokens ?? 0;
    const output = last.output_tokens ?? 0;
    addEvent(summary, tsMs, {
      total: last.total_tokens ?? rawInput + output,
      input: Math.max(0, rawInput - cacheRead),
      output,
      cacheRead,
      cacheWrite: 0,
    });
  });
  return summary;
}

function parseClineTask(filePath) {
  const summary = newSummary("cline");
  let messages;
  try {
    messages = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return summary;
  }
  if (!Array.isArray(messages)) return summary;
  for (const message of messages) {
    if (message?.say !== "api_req_started" || typeof message.ts !== "number") continue;
    let info;
    try {
      info = JSON.parse(message.text ?? "{}");
    } catch {
      continue;
    }
    const input = info.tokensIn ?? 0;
    const output = info.tokensOut ?? 0;
    const cacheWrite = info.cacheWrites ?? 0;
    const cacheRead = info.cacheReads ?? 0;
    addEvent(summary, message.ts, {
      total: input + output + cacheWrite + cacheRead,
      input,
      output,
      cacheRead,
      cacheWrite,
    });
  }
  return summary;
}

function listFilesRecursive(dir, suffix, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(full, suffix, out);
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

export class UsageHistory {
  constructor({
    claudeProjectsDir,
    codexSessionsDir,
    clineTaskDirs,
    cacheFile = defaultCacheFile(),
    now = Date.now,
  } = {}) {
    const roots = defaultSourceRoots();
    this.claudeProjectsDir = claudeProjectsDir ?? roots.claudeProjectsDir;
    this.codexSessionsDir = codexSessionsDir ?? roots.codexSessionsDir;
    this.clineTaskDirs = clineTaskDirs ?? roots.clineTaskDirs;
    this.cacheFile = cacheFile;
    this.now = now;
  }

  #discover() {
    const files = [];
    for (const file of listFilesRecursive(this.claudeProjectsDir, ".jsonl")) {
      files.push({ file, parse: parseClaudeTranscript });
    }
    for (const file of listFilesRecursive(this.codexSessionsDir, ".jsonl")) {
      files.push({ file, parse: parseCodexRollout });
    }
    for (const tasksDir of this.clineTaskDirs) {
      let taskIds;
      try {
        taskIds = readdirSync(tasksDir);
      } catch {
        continue;
      }
      for (const taskId of taskIds) {
        files.push({ file: join(tasksDir, taskId, "ui_messages.json"), parse: parseClineTask });
      }
    }
    return files;
  }

  #loadCache() {
    try {
      const cache = JSON.parse(readFileSync(this.cacheFile, "utf8"));
      return cache.version === CACHE_VERSION ? cache.files : {};
    } catch {
      return {};
    }
  }

  #saveCache(files) {
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      const temporaryFile = `${this.cacheFile}.writing.${process.pid}`;
      writeFileSync(
        temporaryFile,
        JSON.stringify({ version: CACHE_VERSION, files }),
        { mode: 0o600 },
      );
      renameSync(temporaryFile, this.cacheFile);
    } catch {
      /* cache is an optimization; never fail the scan over it */
    }
  }

  collectCached() {
    const startMs = this.now();
    const summaries = Object.values(this.#loadCache())
      .map((entry) => entry?.summary)
      .filter(Boolean);
    return this.#aggregate(summaries, { startMs, parsedFiles: 0 });
  }

  collect() {
    const startMs = this.now();
    const cache = this.#loadCache();
    const nextCache = {};
    const checkpointCache = { ...cache };
    const summaries = [];
    let parsedFiles = 0;
    let lastCheckpointMs = Date.now();
    for (const { file, parse } of this.#discover()) {
      let stats;
      try {
        stats = statSync(file);
      } catch {
        continue;
      }
      const cacheKey = `${file}`;
      const cached = cache[cacheKey];
      if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
        nextCache[cacheKey] = cached;
        summaries.push(cached.summary);
        continue;
      }
      const summary = parse(file);
      parsedFiles += 1;
      const entry = { size: stats.size, mtimeMs: stats.mtimeMs, summary };
      nextCache[cacheKey] = entry;
      checkpointCache[cacheKey] = entry;
      summaries.push(summary);
      const checkpointDue =
        stats.size >= 64 * 1024 * 1024 ||
        parsedFiles % 25 === 0 ||
        Date.now() - lastCheckpointMs >= 5_000;
      if (checkpointDue) {
        this.#saveCache(checkpointCache);
        lastCheckpointMs = Date.now();
      }
    }
    this.#saveCache(nextCache);
    return this.#aggregate(summaries, { startMs, parsedFiles });
  }

  #aggregate(summaries, { startMs, parsedFiles }) {
    const days = new Map();
    const hours = Array(24).fill(0);
    const byPlatform = {
      claudeCode: { tokens: 0, sessions: 0, events: 0 },
      codex: { tokens: 0, sessions: 0, events: 0 },
      cline: { tokens: 0, sessions: 0, events: 0 },
    };
    const sessions = [];
    const totals = emptyBucket();

    for (const summary of summaries) {
      if (summary.events === 0) continue;
      const platform = byPlatform[summary.platform];
      platform.tokens += summary.totalTokens;
      platform.events += summary.events;
      if (!summary.sidechain) {
        platform.sessions += 1;
        sessions.push({
          platform: summary.platform,
          tokens: summary.totalTokens,
          durationMs: summary.lastMs - summary.firstMs,
          startMs: summary.firstMs,
        });
      }
      for (let hour = 0; hour < 24; hour += 1) hours[hour] += summary.hours[hour];
      for (const [date, bucket] of Object.entries(summary.days)) {
        const merged = days.get(date) ?? {
          date,
          ...emptyBucket(),
          byPlatform: { claudeCode: 0, codex: 0, cline: 0 },
        };
        merged.total += bucket.total;
        merged.input += bucket.input;
        merged.output += bucket.output;
        merged.cacheRead += bucket.cacheRead;
        merged.cacheWrite += bucket.cacheWrite;
        merged.events += bucket.events;
        merged.byPlatform[summary.platform] += bucket.total;
        days.set(date, merged);
        totals.total += bucket.total;
        totals.input += bucket.input;
        totals.output += bucket.output;
        totals.cacheRead += bucket.cacheRead;
        totals.cacheWrite += bucket.cacheWrite;
      }
    }

    const sortedDays = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    const stats = this.#stats(sortedDays, hours, sessions, totals, byPlatform);
    return {
      generatedAtMs: this.now(),
      scanMs: this.now() - startMs,
      parsedFiles,
      totalFiles: summaries.length,
      days: sortedDays,
      hours,
      byPlatform,
      stats,
    };
  }

  #stats(days, hours, sessions, totals, byPlatform) {
    const active = days.filter((day) => day.total > 0);
    const peakDay = active.reduce((max, day) => (day.total > (max?.total ?? 0) ? day : max), null);

    let currentStreak = 0;
    let longestStreak = 0;
    let run = 0;
    let previousMs = null;
    for (const day of active) {
      const dayMs = Date.parse(`${day.date}T12:00:00`);
      run = previousMs != null && dayMs - previousMs <= MS_PER_DAY * 1.5 ? run + 1 : 1;
      longestStreak = Math.max(longestStreak, run);
      previousMs = dayMs;
    }
    if (active.length > 0) {
      const todayKey = localDateKey(this.now());
      const yesterdayKey = localDateKey(this.now() - MS_PER_DAY);
      const lastActive = active.at(-1).date;
      currentStreak = lastActive === todayKey || lastActive === yesterdayKey ? run : 0;
    }

    const sessionTokens = sessions.map((s) => s.tokens).sort((a, b) => a - b);
    const medianSessionTokens =
      sessionTokens.length === 0 ? 0 : sessionTokens[Math.floor(sessionTokens.length / 2)];
    const largestSession = sessions.reduce(
      (max, s) => (s.tokens > (max?.tokens ?? 0) ? s : max),
      null,
    );
    const longestSession = sessions.reduce(
      (max, s) => (s.durationMs > (max?.durationMs ?? 0) ? s : max),
      null,
    );

    const weekdayTotals = Array(7).fill(0);
    for (const day of active) {
      weekdayTotals[new Date(`${day.date}T12:00:00`).getDay()] += day.total;
    }
    const peakHour = hours.indexOf(Math.max(...hours));
    const busiestWeekday = weekdayTotals.indexOf(Math.max(...weekdayTotals));
    const inputSide = totals.input + totals.cacheRead + totals.cacheWrite;

    return {
      lifetimeTokens: totals.total,
      daysActive: active.length,
      daysObserved: days.length,
      firstActivityDate: active[0]?.date ?? null,
      avgPerActiveDay: active.length === 0 ? 0 : Math.round(totals.total / active.length),
      peakDay: peakDay ? { date: peakDay.date, tokens: peakDay.total } : null,
      currentStreakDays: currentStreak,
      longestStreakDays: longestStreak,
      sessionCount: sessions.length,
      medianSessionTokens,
      largestSessionTokens: largestSession?.tokens ?? 0,
      longestSessionMs: longestSession?.durationMs ?? 0,
      cacheReadShare: inputSide === 0 ? 0 : totals.cacheRead / inputSide,
      outputShare: totals.total === 0 ? 0 : totals.output / totals.total,
      peakHour,
      busiestWeekday,
      weekdayTotals,
      topDays: [...active]
        .sort((a, b) => b.total - a.total)
        .slice(0, 5)
        .map((day) => ({ date: day.date, tokens: day.total })),
      byPlatform,
    };
  }
}
