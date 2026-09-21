import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import {
  analyzeBody,
  decodeCacheBody,
  decodeGzipLenient,
  findStreamEnd,
  gzipMemberOffsets,
  parseSimpleCacheHeader,
  readSimpleCacheEntry,
  readSimpleCacheKey,
  SimpleCacheKeyIndex,
  SIMPLE_CACHE_HEADER_BYTES,
} from "../integrations/claude-desktop/src/simple-cache.mjs";
import { simpleCacheFileName } from "../integrations/claude-desktop/src/cloud-session-store.mjs";
import { buildSimpleCacheEntry, writeSimpleCacheEntry, FINAL_MAGIC } from "./fixtures/simple-cache-entry.mjs";

const hasZstd = typeof zlib.zstdCompressSync === "function";

test("Simple Cache header, key, and stream boundary are parsed", () => {
  const body = Buffer.from("{\"data\":[]}");
  const file = buildSimpleCacheEntry("https://claude.ai/x", body);
  const header = parseSimpleCacheHeader(file);
  assert.equal(header.magicOk, true);
  assert.equal(header.key, "1/0/https://claude.ai/x");
  const bounds = findStreamEnd(file, header.bodyStart);
  assert.equal(file.subarray(header.bodyStart, bounds.end).toString(), body.toString());
  assert.equal(file.subarray(bounds.stream0Start, bounds.stream0Start + 8).toString("latin1"), "HTTP/1.1");

  const withDigest = buildSimpleCacheEntry("https://claude.ai/x", body, { keySha256: true });
  const digestHeader = parseSimpleCacheHeader(withDigest);
  const digestBounds = findStreamEnd(withDigest, digestHeader.bodyStart);
  assert.equal(withDigest.subarray(digestHeader.bodyStart, digestBounds.end).toString(), body.toString());
  assert.equal(withDigest.subarray(digestBounds.stream0Start, digestBounds.stream0Start + 8).toString("latin1"), "HTTP/1.1");
});

test("an open stream without an EOF record runs to the end of the file", () => {
  const body = Buffer.from(":keepalive\n\ndata: {\"sequence_num\":1}\n\n");
  const file = buildSimpleCacheEntry("https://claude.ai/stream", body, { open: true });
  const header = parseSimpleCacheHeader(file);
  assert.equal(findStreamEnd(file, header.bodyStart), null);
});

test("a body containing the EOF magic by coincidence is not cut short", () => {
  const body = Buffer.concat([Buffer.from("{\"x\":\""), FINAL_MAGIC, Buffer.from("\"}")]);
  const file = buildSimpleCacheEntry("https://claude.ai/y", body);
  const header = parseSimpleCacheHeader(file);
  assert.equal(findStreamEnd(file, header.bodyStart).end - header.bodyStart, body.length);
});

test("unfinished compressed streams decode up to their last flushed block", { skip: !hasZstd && "zstd unavailable" }, async () => {
  const frames = Array.from({ length: 200 }, (_, index) => Buffer.from(`data: {"sequence_num":${index + 1},"payload":{"type":"user","message":{"content":"${"x".repeat(120)}"}}}\n\n`));
  const flushAll = (stream) =>
    new Promise((resolve) => {
      const out = [];
      stream.on("data", (chunk) => out.push(chunk));
      let index = 0;
      const step = () => {
        if (index >= frames.length) return stream.flush(() => resolve(Buffer.concat(out)));
        stream.write(frames[index++]);
        stream.flush(step);
      };
      step();
    });
  for (const [name, stream] of [["zstd", zlib.createZstdCompress()], ["gzip", zlib.createGzip()], ["brotli", zlib.createBrotliCompress()]]) {
    const wire = await flushAll(stream);
    const cut = wire.subarray(0, Math.floor(wire.length * 0.6));
    const decoded = decodeCacheBody(cut, { truncated: true });
    assert.equal(decoded.format, name);
    const framesOut = (decoded.bytes.toString().match(/\n\n/g) ?? []).length;
    assert.ok(framesOut > 50 && framesOut < 200, `${name}: ${framesOut} frames`);
  }
  assert.deepEqual(decodeCacheBody(Buffer.alloc(0), { truncated: true }), { format: "empty", bytes: Buffer.alloc(0), partial: true });
});

test("body decoding sniffs zstd, gzip, brotli, JSON, and SSE text", { skip: !hasZstd && "zstd unavailable" }, () => {
  const json = Buffer.from("{\"data\":[]}");
  assert.equal(decodeCacheBody(zlib.zstdCompressSync(json)).format, "zstd");
  assert.equal(decodeCacheBody(zlib.gzipSync(json)).format, "gzip");
  assert.equal(decodeCacheBody(zlib.brotliCompressSync(json)).format, "brotli");
  assert.equal(decodeCacheBody(json).format, "raw");
  assert.equal(decodeCacheBody(Buffer.from(": keepalive\n\ndata: {}\n\n")).format, "raw");
  assert.equal(decodeCacheBody(Buffer.from("data: {}\n\n")).format, "raw");
  assert.throws(() => decodeCacheBody(Buffer.from([0x00, 0x01, 0x02, 0x03])), { code: "UNKNOWN_FORMAT" });
});

test("zstd bodies decode even when the trailing EOF and header bytes are included", { skip: !hasZstd && "zstd unavailable" }, () => {
  const body = zlib.zstdCompressSync(Buffer.from("{\"ok\":true}"));
  const file = buildSimpleCacheEntry("https://claude.ai/z", body);
  const header = parseSimpleCacheHeader(file);
  // Simulate the old reader that never trimmed the body.
  const decoded = decodeCacheBody(file.subarray(header.bodyStart));
  assert.equal(decoded.bytes.toString(), "{\"ok\":true}");
});

test("readSimpleCacheEntry returns key, trimmed body, streaming flag, and sniffed headers", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-simple-cache-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const url = "https://claude.ai/v1/code/sessions/session_01HWYa9x7ncCBzndDSGPH4VM/events?limit=200&sort_order=desc";
  const filePath = await writeSimpleCacheEntry(directory, url, Buffer.from("{\"data\":[]}"), {
    headers: "HTTP/1.1 200 OK\0content-encoding: zstd\0cache-control: private, max-age=0\0\0",
  });
  const entry = await readSimpleCacheEntry(filePath);
  assert.equal(entry.key, `1/0/${url}`);
  assert.equal(entry.body.toString(), "{\"data\":[]}");
  assert.equal(entry.truncated, false);
  assert.equal(entry.headers.contentEncoding, "zstd");
  assert.equal(entry.headers.cacheControl, "private, max-age=0");
  assert.equal(await readSimpleCacheKey(filePath), `1/0/${url}`);

  const openPath = await writeSimpleCacheEntry(directory, `${url}&open=1`, Buffer.from(": keepalive\n\n"), { open: true });
  const openEntry = await readSimpleCacheEntry(openPath);
  assert.equal(openEntry.truncated, true);
  assert.equal(openEntry.headers, null);
});

test("key index reads each header once, tracks deletions, and persists across instances", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-simple-cache-index-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const relevant = "https://claude.ai/v1/code/sessions/cse_01HWYa9x7ncCBzndDSGPH4VM/events?limit=100";
  const irrelevant = "https://claude.ai/api/organizations/x";
  await writeSimpleCacheEntry(directory, relevant, Buffer.from("{}"));
  await writeSimpleCacheEntry(directory, irrelevant, Buffer.from("{}"));
  await writeFile(path.join(directory, "index"), "not an entry");
  await writeFile(path.join(directory, "0000000000000000_1"), "stream 2 file");

  let headerReads = 0;
  let clock = 0;
  const persistPath = path.join(directory, "state", "index.json");
  const make = () =>
    new SimpleCacheKeyIndex({
      directory,
      isRelevantKey: (key) => key.includes("/code/sessions/"),
      rescanIntervalMs: 1_000,
      persistPath,
      persistIntervalMs: 0,
      now: () => clock,
      readKey: async (filePath) => {
        headerReads += 1;
        return readSimpleCacheKey(filePath);
      },
    });

  const index = make();
  assert.equal(await index.refresh(), true);
  assert.equal(headerReads, 2);
  assert.deepEqual(index.find().map((entry) => entry.key), [`1/0/${relevant}`]);
  assert.equal(await index.refresh(), false, "not due yet");
  clock += 1_000;
  assert.equal(await index.refresh(), true);
  assert.equal(headerReads, 2, "known names are not re-read");

  const second = "https://claude.ai/v1/code/sessions/session_01HWYa9x7ncCBzndDSGPH4VM/events/stream?from_sequence_num=5";
  await writeSimpleCacheEntry(directory, second, Buffer.from(": keepalive\n\n"), { open: true });
  clock += 1_000;
  await index.refresh();
  assert.equal(headerReads, 3, "only the new file is read");
  assert.equal(index.find().length, 2);

  await rm(path.join(directory, simpleCacheFileName(relevant)));
  clock += 1_000;
  await index.refresh();
  assert.deepEqual(index.find().map((entry) => entry.key), [`1/0/${second}`]);
  await index.close();
  const persisted = JSON.parse(await readFile(persistPath, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(Object.keys(persisted.keys).length, 1);
  assert.equal(persisted.seen.length, 1, "irrelevant names are remembered without their keys");

  headerReads = 0;
  const restored = make();
  clock += 1_000;
  await restored.refresh();
  assert.equal(headerReads, 0, "a persisted index needs no header reads");
  assert.equal(restored.find().length, 1);
});

test("key index surfaces a directory listing failure", async () => {
  const index = new SimpleCacheKeyIndex({
    directory: "/nonexistent/token-meter-cache",
    isRelevantKey: () => true,
  });
  await assert.rejects(() => index.refresh(), { code: "ENOENT" });
});

test("gzip members that restart without trailers decode segment by segment", () => {
  const frame = (index) => Buffer.from(`data: {"sequence_num":${index},"payload":{"type":"user"}}\n\n`);
  // A proxy that opens a fresh gzip member per chunk and never closes the
  // previous one: header + raw deflate (sync-flushed), repeated.
  const member = (index) => {
    const deflate = zlib.deflateRawSync(frame(index), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    return Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0x03]), deflate]);
  };
  const wire = Buffer.concat([member(1), member(2), member(3)]);
  assert.throws(() => zlib.gunzipSync(wire), "a strict decoder rejects the concatenation");
  assert.equal(gzipMemberOffsets(wire).length, 3);
  const lenient = decodeGzipLenient(wire, { maxOutputLength: 1 << 20 });
  assert.equal(lenient.strategy, "members");
  assert.equal(lenient.segments, 3);
  assert.equal(lenient.failedSegments, 0);
  assert.equal((lenient.bytes.toString().match(/^data:/gm) ?? []).length, 3);
  const decoded = decodeCacheBody(wire, { truncated: true });
  assert.equal(decoded.format, "gzip");
  assert.equal(decoded.strategy, "members");
  const analysis = analyzeBody(wire);
  assert.equal(analysis.firstBytesHex.startsWith("1f8b0800"), true);
  assert.equal(analysis.gzipMemberOffsets.length, 3);
  assert.equal(analysis.textual, false);
});

test("plain-text bodies of unknown shape are raw with no events rather than errors", () => {
  const decoded = decodeCacheBody(Buffer.from("resume_token=abc123&interval=30"));
  assert.equal(decoded.format, "raw");
  assert.throws(() => decodeCacheBody(Buffer.from([0x00, 0x01, 0x02, 0x03])), { code: "UNKNOWN_FORMAT" });
});
