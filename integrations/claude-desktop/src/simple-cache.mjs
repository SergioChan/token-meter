// Chromium Simple Cache reader.
//
// Claude Desktop is an Electron app, so every HTTP response it caches lands in
// `~/Library/Application Support/Claude/Cache/Cache_Data` as a Simple Cache
// entry. Each `<hash>_0` file is laid out as:
//
//   SimpleFileHeader (24 bytes: magic, version, key_length, key_hash)
//   key              (the cache key, e.g. `1/0/https://claude.ai/...`)
//   stream 1         (the HTTP response body, as received on the wire)
//   SimpleFileEOF    (24 bytes: magic, flags, crc32, stream_size)
//   stream 0         (serialized HTTP response headers)
//   SimpleFileEOF
//
// The key is plaintext, so the directory can be indexed by URL without knowing
// the exact query string Claude used. The body is stored with its wire
// Content-Encoding, so it may be zstd, gzip, brotli, or raw text. A response
// that is still streaming (an SSE connection, for example) has no EOF record
// yet; its body simply runs to the end of the file and grows over time.
//
// Nothing here interprets response content. Callers receive bytes and decide
// what to keep; this module only locates and decodes them.

import { open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as zlib from "node:zlib";
import { runWithConcurrency } from "./local-data-utils.mjs";

export const SIMPLE_CACHE_HEADER_BYTES = 24;
export const SIMPLE_CACHE_EOF_BYTES = 24;
// net/disk_cache/simple/simple_entry_format.h
const INITIAL_MAGIC = Buffer.from("305c72a71b6dfbfc", "hex"); // 0xfcfb6d1ba7725c30 LE
const FINAL_MAGIC = Buffer.from("d8410d97456ffaf4", "hex"); // 0xf4fa6f45970d41d8 LE
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const ENTRY_FILE_NAME = /^[0-9a-f]{16}_0$/;
const DEFAULT_MAX_KEY_BYTES = 8 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;

export function isSimpleCacheEntryName(name) {
  return typeof name === "string" && ENTRY_FILE_NAME.test(name);
}

/**
 * Parse the fixed header and key from the start of a Simple Cache `_0` file.
 * Returns null when the buffer does not look like a Simple Cache entry or the
 * key is longer than the buffer (the caller may retry with a larger read).
 */
export function parseSimpleCacheHeader(buffer, { maxKeyBytes = DEFAULT_MAX_KEY_BYTES } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < SIMPLE_CACHE_HEADER_BYTES) return null;
  const magicOk = buffer.subarray(0, 8).equals(INITIAL_MAGIC);
  const version = buffer.readUInt32LE(8);
  const keyLength = buffer.readUInt32LE(12);
  if (keyLength <= 0 || keyLength > maxKeyBytes) return null;
  const bodyStart = SIMPLE_CACHE_HEADER_BYTES + keyLength;
  if (bodyStart > buffer.length) return { magicOk, version, keyLength, bodyStart, key: null };
  const key = buffer.subarray(SIMPLE_CACHE_HEADER_BYTES, bodyStart).toString("utf8");
  if (key.includes("\0")) return null;
  return { magicOk, version, keyLength, bodyStart, key };
}

/**
 * Locate the stream-1 EOF record. Returns the body end offset, or null when
 * the entry has no EOF record yet (still being written).
 */
export function findStreamEnd(buffer, bodyStart) {
  let from = bodyStart;
  while (from + SIMPLE_CACHE_EOF_BYTES <= buffer.length) {
    const at = buffer.indexOf(FINAL_MAGIC, from);
    if (at === -1 || at + 20 > buffer.length) return null;
    const streamSize = buffer.readUInt32LE(at + 16);
    // The stream_size field must describe exactly the bytes before the record;
    // otherwise the magic occurred inside the body by coincidence.
    if (at - bodyStart === streamSize) return at;
    from = at + 1;
  }
  return null;
}

/**
 * Best-effort extraction of a few response headers from stream 0, used for
 * diagnostics only. Stream 0 is a Chromium pickle; header lines inside it are
 * NUL-separated ASCII, which is enough for a case-insensitive scan.
 */
export function sniffResponseHeaders(buffer, from) {
  if (from == null || from >= buffer.length) return null;
  const text = buffer.subarray(from, Math.min(buffer.length, from + 16 * 1024)).toString("latin1");
  const pick = (name) => {
    const match = new RegExp(`(?:^|\\0)${name}:\\s*([^\\0]*)`, "i").exec(text);
    return match ? match[1].trim().slice(0, 200) : null;
  };
  const status = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(text);
  return {
    status: status ? Number(status[1]) : null,
    contentType: pick("content-type"),
    contentEncoding: pick("content-encoding"),
    cacheControl: pick("cache-control"),
  };
}

function looksTextual(buffer) {
  let index = 0;
  while (index < buffer.length && (buffer[index] === 0x20 || buffer[index] === 0x0a || buffer[index] === 0x0d || buffer[index] === 0x09 || buffer[index] === 0xef || buffer[index] === 0xbb || buffer[index] === 0xbf)) {
    index += 1;
  }
  if (index >= buffer.length) return false;
  const byte = buffer[index];
  if (byte === 0x7b || byte === 0x5b || byte === 0x3a) return true; // { [ :
  const head = buffer.subarray(index, index + 8).toString("latin1");
  return /^(?:data:|event:|id:|retry:)/.test(head);
}

/**
 * Decode a stored response body, sniffing the wire encoding. Returns
 * `{ format, bytes }` or throws an Error with `code` set to one of
 * `ZSTD_UNSUPPORTED`, `DECODE_FAILED`, `UNKNOWN_FORMAT`, `TOO_LARGE`.
 */
export function decodeCacheBody(body, { maxDecodedBytes = DEFAULT_MAX_DECODED_BYTES } = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (!Buffer.isBuffer(body) || body.length === 0) throw fail("DECODE_FAILED", "empty body");

  if (body.subarray(0, 4).equals(ZSTD_MAGIC)) {
    if (typeof zlib.zstdDecompressSync !== "function") {
      throw fail("ZSTD_UNSUPPORTED", "Node.js without zstd support cannot decode this entry");
    }
    let bytes;
    try {
      bytes = zlib.zstdDecompressSync(body, { maxOutputLength: maxDecodedBytes });
    } catch (error) {
      throw fail("DECODE_FAILED", `zstd: ${error.message}`);
    }
    if (bytes.length > maxDecodedBytes) throw fail("TOO_LARGE", "decoded body exceeds limit");
    return { format: "zstd", bytes };
  }
  if (body.subarray(0, 2).equals(GZIP_MAGIC)) {
    try {
      return { format: "gzip", bytes: zlib.gunzipSync(body, { maxOutputLength: maxDecodedBytes }) };
    } catch (error) {
      throw fail("DECODE_FAILED", `gzip: ${error.message}`);
    }
  }
  if (looksTextual(body)) return { format: "raw", bytes: body };
  // Brotli has no magic number; it is the last resort and must produce text.
  try {
    const bytes = zlib.brotliDecompressSync(body, { maxOutputLength: maxDecodedBytes });
    if (looksTextual(bytes)) return { format: "brotli", bytes };
  } catch {
    // fall through
  }
  throw fail("UNKNOWN_FORMAT", "response body is not zstd, gzip, brotli, JSON, or SSE text");
}

/**
 * Read only the key of a Simple Cache entry (header plus key bytes).
 */
export async function readSimpleCacheKey(filePath, { maxKeyBytes = DEFAULT_MAX_KEY_BYTES } = {}) {
  const handle = await open(filePath, "r");
  try {
    const first = Buffer.allocUnsafe(SIMPLE_CACHE_HEADER_BYTES + 1024);
    const { bytesRead } = await handle.read(first, 0, first.length, 0);
    let parsed = parseSimpleCacheHeader(first.subarray(0, bytesRead), { maxKeyBytes });
    if (parsed == null) return null;
    if (parsed.key == null) {
      const full = Buffer.allocUnsafe(parsed.bodyStart);
      const second = await handle.read(full, 0, full.length, 0);
      parsed = parseSimpleCacheHeader(full.subarray(0, second.bytesRead), { maxKeyBytes });
      if (parsed?.key == null) return null;
    }
    return parsed.key;
  } finally {
    await handle.close();
  }
}

/**
 * Read a whole entry: key, stream-1 body (trimmed to its EOF record when one
 * exists), whether the body is still being written, and sniffed headers.
 */
export async function readSimpleCacheEntry(
  filePath,
  { maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES, maxKeyBytes = DEFAULT_MAX_KEY_BYTES } = {},
) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) return null;
  if (fileStat.size > maxEntryBytes) {
    throw Object.assign(new Error(`cache entry exceeds ${maxEntryBytes} bytes`), { code: "TOO_LARGE" });
  }
  const buffer = await readFile(filePath);
  const header = parseSimpleCacheHeader(buffer, { maxKeyBytes });
  if (header?.key == null) return null;
  const end = findStreamEnd(buffer, header.bodyStart);
  const body = buffer.subarray(header.bodyStart, end ?? buffer.length);
  return {
    key: header.key,
    body,
    truncated: end == null,
    headers: end == null ? null : sniffResponseHeaders(buffer, end + SIMPLE_CACHE_EOF_BYTES),
    sizeBytes: fileStat.size,
    modifiedMs: fileStat.mtimeMs,
  };
}

/**
 * Incremental key index over a Simple Cache directory.
 *
 * File names are a hash of the key, so a name maps to one key forever. The
 * index therefore reads each header once, remembers which names were
 * irrelevant, and on later refreshes only opens files it has never seen. The
 * relevant-key filter keeps memory and any persisted state limited to the
 * URLs the caller actually cares about.
 */
export class SimpleCacheKeyIndex {
  constructor({
    directory,
    isRelevantKey,
    rescanIntervalMs = 5_000,
    readConcurrency = 16,
    maxHeaderReadsPerRefresh = 4_000,
    persistPath = null,
    persistIntervalMs = 15_000,
    now = Date.now,
    readKey = readSimpleCacheKey,
    listDirectory = (dir) => readdir(dir),
  } = {}) {
    if (!directory) throw new TypeError("directory is required");
    if (typeof isRelevantKey !== "function") throw new TypeError("isRelevantKey is required");
    this.directory = directory;
    this.isRelevantKey = isRelevantKey;
    this.rescanIntervalMs = rescanIntervalMs;
    this.readConcurrency = readConcurrency;
    this.maxHeaderReadsPerRefresh = maxHeaderReadsPerRefresh;
    this.persistPath = persistPath;
    this.persistIntervalMs = persistIntervalMs;
    this.now = now;
    this.readKey = readKey;
    this.listDirectory = listDirectory;
    // name -> key (relevant) | null (seen, irrelevant or unreadable)
    this.entries = new Map();
    this.lastScanMs = null;
    this.lastDirectoryMtimeMs = null;
    this.pendingNames = [];
    this.dirty = false;
    this.lastPersistMs = 0;
    this.loaded = false;
    this.lastError = null;
    this.stats = { scannedFiles: 0, headerReads: 0, relevant: 0, backlog: 0 };
  }

  async #loadPersisted() {
    this.loaded = true;
    if (!this.persistPath) return;
    try {
      const raw = JSON.parse(await readFile(this.persistPath, "utf8"));
      if (raw?.version !== 1 || raw.directory !== this.directory) return;
      for (const name of raw.seen ?? []) {
        if (isSimpleCacheEntryName(name)) this.entries.set(name, null);
      }
      for (const [name, key] of Object.entries(raw.keys ?? {})) {
        if (isSimpleCacheEntryName(name) && typeof key === "string" && this.isRelevantKey(key)) {
          this.entries.set(name, key);
        }
      }
    } catch {
      // A missing or corrupt index just means a full first scan.
    }
  }

  async #persist(force = false) {
    if (!this.persistPath || !this.dirty) return;
    const nowMs = this.now();
    if (!force && nowMs - this.lastPersistMs < this.persistIntervalMs) return;
    const seen = [];
    const keys = {};
    for (const [name, key] of this.entries) {
      if (key == null) seen.push(name);
      else keys[name] = key;
    }
    const payload = JSON.stringify({ version: 1, directory: this.directory, seen, keys });
    const temporary = `${this.persistPath}.${process.pid}.tmp`;
    try {
      mkdirSync(path.dirname(this.persistPath), { recursive: true, mode: 0o700 });
      await writeFile(temporary, payload, { mode: 0o600 });
      await rename(temporary, this.persistPath);
      this.dirty = false;
      this.lastPersistMs = nowMs;
    } catch {
      // Persistence is an optimization only.
    }
  }

  /**
   * Rescan the directory when due. Returns true when the scan ran.
   */
  async refresh({ force = false } = {}) {
    if (!this.loaded) await this.#loadPersisted();
    const nowMs = this.now();
    const due =
      force ||
      this.lastScanMs == null ||
      this.pendingNames.length > 0 ||
      nowMs - this.lastScanMs >= this.rescanIntervalMs;
    if (!due) return false;

    if (this.pendingNames.length === 0) {
      let names;
      try {
        // Listing tens of thousands of entries is the expensive step. A
        // directory's mtime changes whenever an entry is created or removed,
        // so an unchanged mtime means the previous listing is still exact.
        const directoryStat = await stat(this.directory);
        if (!force && this.lastDirectoryMtimeMs === directoryStat.mtimeMs) {
          this.lastScanMs = nowMs;
          return false;
        }
        names = await this.listDirectory(this.directory);
        this.lastDirectoryMtimeMs = directoryStat.mtimeMs;
        this.lastError = null;
      } catch (error) {
        this.lastError = error;
        this.lastScanMs = nowMs;
        throw error;
      }
      const present = new Set();
      for (const name of names) {
        if (!isSimpleCacheEntryName(name)) continue;
        present.add(name);
        if (!this.entries.has(name)) this.pendingNames.push(name);
      }
      for (const name of [...this.entries.keys()]) {
        if (!present.has(name)) {
          this.entries.delete(name);
          this.dirty = true;
        }
      }
      this.stats.scannedFiles = present.size;
      this.lastScanMs = nowMs;
    }

    const batch = this.pendingNames.splice(0, this.maxHeaderReadsPerRefresh);
    if (batch.length > 0) {
      await runWithConcurrency(batch, this.readConcurrency, async (name) => {
        let key = null;
        try {
          key = await this.readKey(path.join(this.directory, name));
        } catch {
          key = null;
        }
        this.entries.set(name, key != null && this.isRelevantKey(key) ? key : null);
        this.stats.headerReads += 1;
      });
      this.dirty = true;
    }
    this.stats.backlog = this.pendingNames.length;
    this.stats.relevant = 0;
    for (const key of this.entries.values()) if (key != null) this.stats.relevant += 1;
    await this.#persist();
    return true;
  }

  /** Relevant entries whose key satisfies the predicate. */
  find(predicate = () => true) {
    const matches = [];
    for (const [name, key] of this.entries) {
      if (key != null && predicate(key)) {
        matches.push({ name, key, path: path.join(this.directory, name) });
      }
    }
    return matches;
  }

  async close() {
    await this.#persist(true);
  }
}
