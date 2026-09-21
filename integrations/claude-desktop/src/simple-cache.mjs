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

const EOF_FLAG_HAS_KEY_SHA256 = 1 << 1;

/**
 * Locate the end of stream 1 (the response body).
 *
 * A finished entry ends with stream 0's EOF record, whose `stream_size` is the
 * length of stream 0 (the EOF record for stream 1 leaves that field unused).
 * Walking back from the end of the file therefore lands exactly on stream 1's
 * EOF record: `[body][EOF1][stream0][key sha256?][EOF0]`. Returns
 * `{ end, stream0Start }`, or null when the entry has no EOF record yet
 * (Chromium is still appending to it).
 */
export function findStreamEnd(buffer, bodyStart) {
  const length = buffer.length;
  if (length - bodyStart >= 2 * SIMPLE_CACHE_EOF_BYTES) {
    const eof0 = length - SIMPLE_CACHE_EOF_BYTES;
    if (buffer.subarray(eof0, eof0 + 8).equals(FINAL_MAGIC)) {
      const flags = buffer.readUInt32LE(eof0 + 8);
      const stream0Size = buffer.readUInt32LE(eof0 + 16);
      const shaBytes = flags & EOF_FLAG_HAS_KEY_SHA256 ? 32 : 0;
      const stream0Start = eof0 - shaBytes - stream0Size;
      const eof1 = stream0Start - SIMPLE_CACHE_EOF_BYTES;
      if (eof1 >= bodyStart && buffer.subarray(eof1, eof1 + 8).equals(FINAL_MAGIC)) {
        return { end: eof1, stream0Start };
      }
    }
  }
  // Fallback for layouts this reader does not model: the first EOF magic
  // after the body start. An 8-byte magic inside compressed data is unlikely.
  const at = buffer.indexOf(FINAL_MAGIC, bodyStart);
  return at === -1 ? null : { end: at, stream0Start: at + SIMPLE_CACHE_EOF_BYTES };
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

const GZIP_MEMBER_HEAD = Buffer.from([0x1f, 0x8b, 0x08]);
const SYNC_FLUSH_MARKER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/** Offsets of plausible gzip member headers (`1f 8b 08 <flags<=0x1f>`). */
export function gzipMemberOffsets(body) {
  const offsets = [];
  let from = 0;
  while (from < body.length) {
    const at = body.indexOf(GZIP_MEMBER_HEAD, from);
    if (at === -1) break;
    if (at + 10 <= body.length && body[at + 3] <= 0x1f) offsets.push(at);
    from = at + 1;
  }
  return offsets;
}

function gzipHeaderLength(segment) {
  // RFC 1952: fixed 10 bytes, then optional FEXTRA, FNAME, FCOMMENT, FHCRC.
  if (segment.length < 10) return null;
  const flags = segment[3];
  let offset = 10;
  if (flags & 0x04) {
    if (offset + 2 > segment.length) return null;
    offset += 2 + segment.readUInt16LE(offset);
  }
  for (const bit of [0x08, 0x10]) {
    if (flags & bit) {
      const end = segment.indexOf(0, offset);
      if (end === -1) return null;
      offset = end + 1;
    }
  }
  if (flags & 0x02) offset += 2;
  return offset <= segment.length ? offset : null;
}

/**
 * Decode gzip data that a strict decoder rejects, in order of preference:
 * an unfinished member (Z_SYNC_FLUSH), several members that restart without
 * trailers (inflate each raw deflate segment on its own), and finally a
 * back-off to the last sync-flush marker. Returns `{ bytes, strategy,
 * segments, failedSegments }` or null.
 */
export function decodeGzipLenient(body, { maxOutputLength }) {
  try {
    return {
      bytes: zlib.gunzipSync(body, { maxOutputLength, finishFlush: zlib.constants.Z_SYNC_FLUSH }),
      strategy: "sync-flush",
      segments: 1,
      failedSegments: 0,
    };
  } catch {
    // fall through
  }
  const offsets = gzipMemberOffsets(body);
  if (offsets.length > 0) {
    const parts = [];
    let failed = 0;
    for (let index = 0; index < offsets.length; index += 1) {
      const segment = body.subarray(offsets[index], offsets[index + 1] ?? body.length);
      const headerLength = gzipHeaderLength(segment);
      if (headerLength == null) {
        failed += 1;
        continue;
      }
      try {
        parts.push(
          zlib.inflateRawSync(segment.subarray(headerLength), {
            maxOutputLength,
            finishFlush: zlib.constants.Z_SYNC_FLUSH,
          }),
        );
      } catch {
        failed += 1;
      }
    }
    if (parts.length > 0) {
      return {
        bytes: Buffer.concat(parts),
        strategy: "members",
        segments: offsets.length,
        failedSegments: failed,
      };
    }
  }
  const marker = body.lastIndexOf(SYNC_FLUSH_MARKER);
  if (marker > 0) {
    try {
      return {
        bytes: zlib.gunzipSync(body.subarray(0, marker + 4), {
          maxOutputLength,
          finishFlush: zlib.constants.Z_SYNC_FLUSH,
        }),
        strategy: "marker-backoff",
        segments: 1,
        failedSegments: 0,
      };
    } catch {
      // fall through
    }
  }
  return null;
}

/** Structural facts about a body for diagnostics; never returns content. */
export function analyzeBody(body) {
  const markers = [];
  let from = 0;
  while (markers.length < 10_000) {
    const at = body.indexOf(SYNC_FLUSH_MARKER, from);
    if (at === -1) break;
    markers.push(at);
    from = at + 1;
  }
  return {
    bytes: body.length,
    firstBytesHex: body.subarray(0, 16).toString("hex"),
    gzipMemberOffsets: gzipMemberOffsets(body).slice(0, 50),
    syncFlushMarkers: markers.length,
    textual: looksTextual(body),
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
  if (/^(?:data:|event:|id:|retry:)/.test(head)) return true;
  // Any other plain-text body (a form-encoded poll answer, for example) is
  // "raw" with no events rather than an unknown binary format.
  const sample = buffer.subarray(index, Math.min(buffer.length, index + 64));
  return sample.every((value) => value === 0x09 || value === 0x0a || value === 0x0d || (value >= 0x20 && value < 0x7f));
}

function partialText(bytes) {
  return looksTextual(bytes) ? bytes : null;
}

/**
 * Decode a stored response body, sniffing the wire encoding. Returns
 * `{ format, bytes, partial }`; `partial` is true when the data was an
 * unfinished compressed stream and only the flushed prefix could be decoded.
 * Throws an Error with `code` set to one of `ZSTD_UNSUPPORTED`,
 * `DECODE_FAILED`, `UNKNOWN_FORMAT`, `TOO_LARGE`.
 */
export function decodeCacheBody(body, { maxDecodedBytes = DEFAULT_MAX_DECODED_BYTES, truncated = false } = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (!Buffer.isBuffer(body)) throw fail("DECODE_FAILED", "missing body");
  if (body.length === 0) return { format: "empty", bytes: body, partial: truncated };

  if (body.subarray(0, 4).equals(ZSTD_MAGIC)) {
    if (typeof zlib.zstdDecompressSync !== "function") {
      throw fail("ZSTD_UNSUPPORTED", "Node.js without zstd support cannot decode this entry");
    }
    // zstd returns the frames it could finish and stops at a cut block.
    let bytes;
    try {
      bytes = zlib.zstdDecompressSync(body, { maxOutputLength: maxDecodedBytes });
    } catch (error) {
      try {
        bytes = zlib.zstdDecompressSync(body, {
          maxOutputLength: maxDecodedBytes,
          finishFlush: zlib.constants.ZSTD_e_flush,
        });
      } catch {
        throw fail("DECODE_FAILED", `zstd: ${error.message}`);
      }
    }
    if (bytes.length > maxDecodedBytes) throw fail("TOO_LARGE", "decoded body exceeds limit");
    return { format: "zstd", bytes, partial: truncated };
  }
  if (body.subarray(0, 2).equals(GZIP_MAGIC)) {
    try {
      return { format: "gzip", bytes: zlib.gunzipSync(body, { maxOutputLength: maxDecodedBytes }), partial: false };
    } catch (error) {
      const lenient = decodeGzipLenient(body, { maxOutputLength: maxDecodedBytes });
      if (lenient == null) throw fail("DECODE_FAILED", `gzip: ${error.message}`);
      return {
        format: "gzip",
        bytes: lenient.bytes,
        partial: true,
        strategy: lenient.strategy,
        segments: lenient.segments,
        failedSegments: lenient.failedSegments,
      };
    }
  }
  if (looksTextual(body)) return { format: "raw", bytes: body, partial: truncated };
  // Brotli has no magic number; it is the last resort and must produce text.
  let brotliError = null;
  for (const options of [
    { maxOutputLength: maxDecodedBytes },
    { maxOutputLength: maxDecodedBytes, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH },
  ]) {
    try {
      const bytes = partialText(zlib.brotliDecompressSync(body, options));
      if (bytes) return { format: "brotli", bytes, partial: options.finishFlush != null || truncated };
    } catch (error) {
      brotliError = error;
    }
  }
  throw fail(
    "UNKNOWN_FORMAT",
    `response body is not zstd, gzip, brotli, JSON, or SSE text (first bytes ${body.subarray(0, 8).toString("hex")}${brotliError ? `; brotli: ${brotliError.message}` : ""})`,
  );
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
  const bounds = findStreamEnd(buffer, header.bodyStart);
  const body = buffer.subarray(header.bodyStart, bounds?.end ?? buffer.length);
  return {
    key: header.key,
    body,
    bodyMagic: body.subarray(0, 4).toString("hex"),
    truncated: bounds == null,
    headers: bounds == null ? null : sniffResponseHeaders(buffer, bounds.stream0Start),
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
