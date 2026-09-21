# Claude Desktop Cloud Session Event Cache

## Scope

This note records how Claude Desktop actually fetches the events of a cloud
Code Session (`session_<24 chars>` routes), why the original cloud collector
went permanently unbound, and how the replacement collector stays shape
agnostic. It complements
[the selected-Session signal research](claude-selected-session-signals.md),
which covers identity; this note covers usage data.

Evidence came from three read-only sources:

- the plaintext keys of Simple Cache entries under
  `~/Library/Application Support/Claude/Cache/Cache_Data` on one production
  Mac, collected between 2026-07-12 and 2026-09-20;
- the remote-Session client strings inside the Claude Code `2.1.278` binary
  that runs cloud Sessions (`SessionsV2Client`, `fetchLatestEvents`,
  `fetchOlderEvents`);
- the transcript of one live cloud Session inspected from inside its sandbox.

Identifiers below are redacted to their structural form. No response bodies
were retained.

## Bottom line

A cloud Session's transcript is written inside Anthropic's sandbox under
`~/.claude/projects/...` **there**, not on the Mac. The only local copies of its
events are the HTTP responses Claude Desktop cached while displaying it. Those
responses are cacheable and land in the Chromium Simple Cache, but the request
URL that produces them is not stable:

| Date range | Client | Request shape |
| --- | --- | --- |
| 07-12 | renderer | `session_<id>/events?limit=200&sort_order=desc` |
| 07-15 → 08-04 | embedded | `cse_<id>/events?limit=500`, `…&cursor=N`, `cse_<id>/events/stream` |
| 08-06 | renderer | `session_<id>/events?limit=500&sort_order=desc` |
| 08-14, 08-30, 09-08, 09-13 | renderer | `session_<id>/events?limit=50&sort_order=desc` and `…limit=500&sort_order=desc&cursor=N` |
| 09-01 → 09-18 | embedded | `cse_<id>/events?limit=100`, `…limit=500`, `…limit=500&cursor=N`, `cse_<id>/events/stream?from_sequence_num=N` |
| 09-07 → 09-16 | renderer | `session_<id>/events?limit=200&sort_order=desc` and `…limit=500&sort_order=asc&cursor=500/1000/1500` |
| 09-20 | embedded | only `cse_<id>/events/stream?from_sequence_num=146` for the Session under test |

The original collector (added 2026-08-14) hashed exactly one of these shapes,
`limit=50&sort_order=desc`, and followed `next_cursor` with
`limit=500&sort_order=desc&cursor=`. On the same install that shape was already
absent for most Sessions a month later, and the identifier prefix used by the
embedded client (`cse_`) never matched at all. The visible symptom was
`reason: "cloud-session-cache-missing"` for every cloud Session while local
Sessions kept working.

## Two clients, one Session

Claude Desktop reaches a cloud Session through two independent paths that share
one cache directory:

1. **The renderer** (the `/epitaxy/session_<id>` page) requests
   `/v1/code/sessions/session_<id>/events` with a `sort_order` parameter. Page
   sizes of 50, 200, and 500 and both sort orders have been observed within one
   week, sometimes for the same Session.
2. **An embedded Claude Code client** requests
   `/v1/code/sessions/cse_<id>/events` without `sort_order`, backfills with
   `limit=500&cursor=N`, and then holds an SSE connection to
   `/events/stream?from_sequence_num=N`. This matches the `SessionsV2Client`
   code in the Claude Code binary, which sets `Accept: text/event-stream`, uses
   `Last-Event-ID`, and reconnects with `from_sequence_num`. Because it runs
   through Electron's network stack, its responses land in the same
   `Cache_Data` directory.

`session_<24>` and `cse_<24>` share the same 24-character core; the mapping was
confirmed from inside a live cloud Session, where
`CLAUDE_CODE_REMOTE_SESSION_ID` is the `cse_` form of the Desktop route's
`session_` form.

## Two facts about the cache bodies

- The bytes right after a key are the wire body. Entries for `/events` pages
  start with the zstd magic `28 b5 2f fd`; entries for `/events/stream` start
  with the SSE comment `:keepalive` in plain text. Content-Encoding therefore
  varies per response and must be sniffed, not assumed.
- A response that is still streaming has no EOF record yet. Chromium appends
  to the entry as data arrives, so the open SSE file is the one local artifact
  that can grow while the Session runs. Whether Desktop keeps that connection
  open for the visible Session, and for how long, has not been established on
  the tested install; the collector treats it as a bonus source, not a
  guarantee.

## What the official client tolerates

`fetchLatestEvents` / `fetchOlderEvents` in the Claude Code binary read
`data[]`, keep rows only `if (row?.payload)`, and report the rest as
`droppedRows`. Rows without a payload are therefore a normal part of the
sequence. The original collector skipped them and then demanded contiguity,
which turned every such row into a permanent gap.

The same client also probes a larger page size first and retries with a
smaller one on HTTP 400, so the page size is negotiated, not fixed.

## Replacement design

`integrations/claude-desktop/src/cloud-session-store.mjs` now layers
independent sources and merges everything by `sequence_num`:

1. **Key index** (`simple-cache.mjs`). List the cache directory, read each
   `_0` header once to get its plaintext key, remember which names are
   irrelevant, and persist the map under `Token Meter/State`. Directory
   listings are skipped while the directory mtime is unchanged. A 50,000-entry
   cache indexes in roughly a dozen 350 ms ticks on first launch and in about
   150 ms from the persisted index afterwards; an unchanged tick costs a few
   milliseconds plus one `stat` per matched entry.
2. **Identity matching** (`cloud-events.mjs`). A key is relevant when its last
   URL is on an allowed host and its path contains `/code/sessions/<ref>/…`
   where `<ref>` is any known prefix plus the bound core. Prefixes default to
   `session_` and `cse_` and extend via `TOKEN_METER_CLAUDE_CLOUD_ID_PREFIXES`;
   hosts extend via `TOKEN_METER_CLAUDE_CLOUD_HOSTS`. Query strings are never
   part of the match. `watch` responses are decoded too, but their rows count
   only when they name the Session explicitly.
3. **Decoding**. zstd, gzip, and brotli by sniffing, raw JSON or SSE by first
   byte. Bodies are trimmed at the stream-1 EOF record when one exists (found
   from stream 0's record at the end of the file); an open stream is read to
   end of file and decoded up to its last flushed block. The live
   `/events/stream` body on the tested install is gzip and is rejected by a
   strict decoder with `invalid stored block lengths`. The body is written by
   a level-0 proxy as stored deflate blocks (five-byte header plus plaintext)
   with a sync-flush after each chunk, and strict decoding stops partway
   through. gzip therefore falls back to sync-flush decoding and then to a
   block walker (`walkGzip`) that advances stored block by stored block, lets
   zlib consume Huffman runs bounded at the next member header, skips
   trailers after a final block, tolerates members that restart without
   trailers, and resynchronizes at the next plausible header after corrupt
   bytes. `claude-cache-inspect` prints the walk statistics and the offsets
   and eight header bytes of every anomaly.
4. **Extraction**. Any object carrying `sequence_num` (or `sequenceNum`, or a
   numeric SSE `id:`) becomes an event; containers named `data`, `events`,
   `event`, `items`, `results`, `rows`, `history` are searched to a bounded
   depth. Incomplete trailing SSE frames are skipped.
5. **URL probes**. When the directory cannot be listed, deterministic file
   names are computed for every shape in `KNOWN_FIRST_PAGE_SHAPES` under every
   prefix, and cursor chains are followed in each `KNOWN_CURSOR_PAGE_SHAPES`
   style. Adding a newly observed shape is a one-line table change.
6. **Coverage**. `complete` is true for a contiguous `1..N` sequence; gaps
   yield `coverage.missingSequences` and a partial binding that the overlay
   marks with `≈`. `allowPartial: false` (CLI `--strict`) restores fail-closed
   behavior. Rows without a payload count toward coverage.
7. **Diagnostics**. Every result lists the sources tried, per-entry redacted
   URL shapes, encodings, byte counts, streaming state, and decode errors. The
   bridge logs binding-state changes to its stderr log; `claude-snapshot`
   prints the full block.

Unbound reasons are now specific: `cloud-cache-indexing` (first scan still
running), `cloud-cache-directory-unavailable`,
`cloud-session-cache-missing`, `cloud-session-cache-unreadable`,
`cloud-session-cache-empty`, `cloud-session-cache-incomplete` (strict only),
and `cloud-session-event-limit`.

## Limits that remain

- **Liveness depends on Desktop.** Cached `/events` pages update only when
  Desktop re-requests them. Live numbers require either an open
  `/events/stream` entry that Chromium is appending to, or periodic re-fetches
  by the renderer. Neither is under Token Widget's control.
- **Cache eviction.** Chromium evicts by size and age. A long-idle Session may
  keep only its newest pages, which the partial binding reports honestly.
- **`Cache-Control: no-store`.** If Anthropic ever marks these responses
  non-storable, nothing lands on disk and every source above is empty. The
  diagnostics would show `index=ok/0`.
- **Rejected alternatives.** Reading Desktop's cookies or OAuth tokens to call
  `/events` directly would cross the companion's security boundary and is not
  implemented. Parsing Desktop's IndexedDB/LevelDB for renderer state was not
  validated. Pushing usage out of the sandbox via hooks needs a relay that does
  not exist yet.

## Reproducible checks

```bash
# Which request shapes has Desktop cached for cloud Sessions? (IDs shown; do
# not paste the output anywhere public without redacting them.)
cd ~/Library/Application\ Support/Claude/Cache/Cache_Data
find . -maxdepth 1 -name '*_0' -print0 \
  | xargs -0 grep -l -a '/code/sessions/' 2>/dev/null \
  | while read -r f; do
      printf '%s  %s\n' "$(stat -f '%Sm' -t '%m-%d %H:%M:%S' "$f")" \
        "$(head -c 600 "$f" | grep -a -o 'https://claude.ai/v1/code/sessions/[^[:space:][:cntrl:]]*' | sed 's/(.*//' | head -1)"
    done | sort

# Why is one Session unbound, and which entries were considered?
node src/cli.mjs claude-snapshot --desktop-session-id session_<24 chars>

# Is the SSE entry for a running Session still growing?
f=$(find . -maxdepth 1 -name '*_0' -mtime -1 -print0 \
  | xargs -0 grep -l -a '/events/stream' 2>/dev/null | head -1)
stat -f '%Sm %z' "$f"; sleep 30; stat -f '%Sm %z' "$f"
```
