import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { SIMPLE_CACHE_HEADER_BYTES } from "../../integrations/claude-desktop/src/simple-cache.mjs";
import { simpleCacheFileName } from "../../integrations/claude-desktop/src/cloud-session-store.mjs";

export const INITIAL_MAGIC = Buffer.from("305c72a71b6dfbfc", "hex");
export const FINAL_MAGIC = Buffer.from("d8410d97456ffaf4", "hex");

/**
 * Build a Simple Cache `_0` file the way Chromium lays it out: header, key,
 * stream 1 (body), EOF record, stream 0 (headers), EOF record. `open: true`
 * omits both EOF records to imitate a response that is still streaming.
 */
export function buildSimpleCacheEntry(
  url,
  body,
  { open = false, keySha256 = false, headers = "HTTP/1.1 200 OK\0content-type: application/json\0\0" } = {},
) {
  const key = Buffer.from(`1/0/${url}`, "utf8");
  const header = Buffer.alloc(SIMPLE_CACHE_HEADER_BYTES);
  INITIAL_MAGIC.copy(header, 0);
  header.writeUInt32LE(5, 8);
  header.writeUInt32LE(key.length, 12);
  header.writeUInt32LE(0, 16);
  // net/disk_cache/simple/simple_entry_format.h: stream_size is only used in
  // the EOF record for stream 0; FLAG_HAS_KEY_SHA256 puts the key digest
  // right before that record.
  const eof = (streamSize, flags = 0) => {
    const record = Buffer.alloc(24);
    FINAL_MAGIC.copy(record, 0);
    record.writeUInt32LE(flags, 8);
    record.writeUInt32LE(0, 12);
    record.writeUInt32LE(streamSize, 16);
    return record;
  };
  if (open) return Buffer.concat([header, key, body]);
  const stream0 = Buffer.from(headers, "latin1");
  const sha = keySha256 ? createHash("sha256").update(key).digest() : Buffer.alloc(0);
  return Buffer.concat([header, key, body, eof(0), stream0, sha, eof(stream0.length, keySha256 ? 2 : 0)]);
}

export async function writeSimpleCacheEntry(directory, url, body, options) {
  const filePath = path.join(directory, simpleCacheFileName(url));
  await writeFile(filePath, buildSimpleCacheEntry(url, body, options));
  return filePath;
}

