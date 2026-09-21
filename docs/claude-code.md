# Claude Code in Claude Desktop Integration

## Scope

Token Meter targets the graphical **Code** surface inside Claude Desktop on macOS. It does not target the Claude Code CLI status line.

The supported UI is an independent native overlay. It follows the focused Claude window and displays the same Session, hour, turn, context, rate, baseline, alert, drag, and collapse behavior used by the Codex integration.

## Current status

The native companion is implemented, tested, installable, and live-validated
against both legacy local Sessions and Claude Desktop `1.30096.1` cloud Code
Sessions.

Support is marked **Beta** because selected-Session Accessibility URLs, Desktop
metadata, transcript records, local HTTP-cache records, and the packaged model
catalog are private compatibility surfaces rather than documented Anthropic
extension interfaces.

Implemented modules include:

- Official Claude.app path, bundle, Team ID, signature, executable, and model-catalog verification.
- Exact focused Code Session discovery from an Accessibility URL containing a
  legacy `local_<uuid>` or current mixed-case `session_<24 chars>` identifier.
- Exact local Desktop `sessionId` to Claude Code `cliSessionId` resolution with
  fail-closed ambiguity handling.
- Cloud Session event resolution from Claude's Chromium Simple Cache: a
  plaintext-key index matched by Session identity under every identifier
  prefix, zstd/gzip/brotli/JSON/SSE decoding, sequence-numbered merging across
  pages and the live `/events/stream` body, honest coverage reporting, and URL
  probes in every observed request shape as a fallback.
- Bounded incremental transcript collection with content discard and response-level de-duplication.
- A persistent numerical snapshot bridge rather than one Node process per poll.
- A native non-activating panel that follows Claude, hides outside the eligible Code surface, and supports drag/collapse persistence.
- Active-context numerator and model-window denominator enrichment.
- Isolated build, LaunchAgent, status, update, and uninstall workflows.

Installation is documented in [install-claude-desktop.md](install-claude-desktop.md).

## Why this is a native overlay

Claude Desktop `1.24012.9` rejects `--remote-debugging-port` and `--remote-debugging-pipe` before normal startup unless both `CLAUDE_USER_DATA_DIR` and a valid `CLAUDE_CDP_AUTH` value are present. The authorization is time-limited, bound to the exact data path, and checked with an embedded Anthropic public key. No public third-party issuance flow is documented.

Token Meter does not patch, copy, dynamically modify, or re-sign Claude.app, and it does not attempt to forge or bypass that authorization. The dormant CDP adapter remains useful compatibility research, but it is not the supported production path.

The native companion requires no Claude restart and does not execute inside Claude's renderer.

## Exact Session binding

The companion performs a shallow role-only scan of the focused Claude Accessibility window and requires exactly one eligible `AXWebArea`. Its URL must have an exact route such as:

```text
https://claude.ai/epitaxy/local_<uuid>
```

Current cloud Code Sessions use:

```text
https://claude.ai/epitaxy/session_<24 case-sensitive alphanumeric chars>
```

Older `/code/local_<uuid>` routes remain accepted for compatibility. `AXLink`
sidebar targets, malformed identifiers, extra route components, non-Claude
hosts, and multiple eligible web areas all produce a hidden/unbound state.

The exact Desktop identity is then resolved through metadata under:

```text
~/Library/Application Support/Claude/claude-code-sessions/
```

One `local_<uuid>` must map to one valid `cliSessionId` and absolute project directory. Missing, invalid, or ambiguous metadata produces an unbound state. The adapter never substitutes:

- the newest Claude process;
- the most recently modified transcript;
- the most recent `lastActivityAt` value;
- the most recent `lastFocusedAt` value;
- the Session title or display name.

A `session_<24 chars>` cloud Session takes a separate path. Its transcript lives
in Anthropic's sandbox; the only local copies of its events are the responses
Claude Desktop cached while displaying it. Desktop reaches one Session through
two clients (the renderer with `session_<id>` URLs and an embedded Claude Code
client with `cse_<id>` URLs), and their page sizes, sort orders, and pagination
styles have changed repeatedly. The adapter therefore never guesses a URL:

1. It indexes `~/Library/Application Support/Claude/Cache/Cache_Data` by the
   plaintext key stored in each Simple Cache entry, reading each header once
   and persisting the index under `Token Meter/State`.
2. It matches the bound Session under every known identifier prefix
   (`session_`, `cse_`, plus `TOKEN_METER_CLAUDE_CLOUD_ID_PREFIXES`) and any
   query string, including the open `/events/stream` SSE body that Chromium
   appends to while the connection is alive, and `watch` poll responses whose
   rows name the Session.
3. It decodes zstd, gzip, brotli, raw JSON, or SSE text, extracts
   `sequence_num` + `payload` rows from any wrapper shape, and merges them.
4. When the directory cannot be listed, it probes deterministic file names for
   every request shape observed so far and follows cursor chains in each style.

Events seen once are retained as numerical records (never content), in memory
and under `Token Meter/State/claude-cloud-sessions/<id>.json`, because Desktop
replaces the SSE entry on every reconnect and evicts older pages; the Session
total therefore accumulates for as long as the companion has been watching,
including across its own restarts.

Coverage is reported rather than assumed. A contiguous `1..N` sequence is
`complete`; gaps produce a partial binding flagged with `≈` and a
`binding.coverage` record, or an unbound state when the store runs with
`allowPartial: false` (`claude-snapshot --strict`). Rows without a payload
count toward coverage, child-Agent events are split into a subagent file so the
root Context reading stays exact, and rows attributed to another Session are
discarded. It never falls back to the newest local transcript.

To see why a cloud Session is not measured, run
`node src/cli.mjs claude-snapshot --desktop-session-id session_<id>` (add
`--claude-cache-dir` for a non-default profile); the `diagnostics` block lists
each source, the redacted URL shape of every entry considered, its encoding,
and any decode error. The overlay bridge writes the same summary to its stderr
log whenever the binding state changes.

Read [the selected-Session signal research](research/claude-selected-session-signals.md) for the evidence and rejected fallbacks, and [the cloud event cache research](research/claude-cloud-events-cache.md) for the observed request shapes and remaining limits.

## Runtime architecture

```text
Focused Claude Accessibility window
              |
              v
Exact local_<uuid> or cloud session_<24 chars>
              |
       +------+------+
       |             |
       v             v
Desktop metadata   Complete cached /events pages
       |             |
       v             v
Local transcript   Content-discarding usage collector
       +------v------+
              |
              v
Persistent ClaudeSnapshotRuntime bridge
              |
              v
Shared MetricsEngine
              |
              v
Native non-activating Token Meter panel
```

The complete snapshot switches atomically when the Accessibility Session ID changes. A previous Session's values are never retained under a new identity.

## Usage accounting

Both collectors use the same accounting rules. The local collector reads the
bound transcript; the cloud collector reads only the bound Session's locally
cached events and reports how much of the sequence they cover. They:

1. Reads the exact root transcript and child-Agent transcripts nested under that Session.
2. Retains response IDs, timestamps, event types, turn boundaries, and numerical usage only.
3. Keys assistant usage by `message.id`.
4. Replaces a partial row when a later row updates the same response.
5. Uses the top-level response usage and does not add internal iteration breakdowns again.

Each unique response contributes:

```text
raw tokens = input_tokens
           + cache_creation_input_tokens
           + cache_read_input_tokens
           + output_tokens
```

This follows Anthropic's separate reporting of uncached input, cache creation, and cache reads. See [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and the [Messages usage reference](https://platform.claude.com/docs/en/api/messages/create).

This is local raw model workload. It is not Claude subscription-plan usage, API billing, or an estimate of undisclosed backend weighting.

## Active context

The latest root assistant usage snapshot supplies current input-side occupancy:

```text
active context = input_tokens
               + cache_creation_input_tokens
               + cache_read_input_tokens
```

Output tokens are excluded because Claude Code documents context percentage as input-side usage. A compaction invalidates the reading until the next response supplies fresh usage. See [Claude Code status-line data](https://code.claude.com/docs/en/statusline#available-data).

The transcript does not contain `context_window_size`. The companion obtains the denominator in this order:

1. A strict formatted ratio in an `AXButton` title inside the same exact Code web area, such as `Context window 596.0k / 1.0M (59.6%)`.
2. The exact Session model from Desktop metadata matched against the current installed Claude model catalog.
3. `null` if neither source can prove a value.

It does not read static text or conversation content to find the ratio. The model fallback uses the exact model returned with the bound Session snapshot; its cache is keyed by model and invalidated when the installed catalog changes.

## Native presentation behavior

- The panel appears only while Claude is frontmost and the focused window
  exposes an exact supported Code Session with proven local telemetry.
- The panel follows the host window across displays and macOS Spaces.
- Expanded mode drags by the header.
- Collapsed mode shows only the gauge, live rate, and expand button and drags by the gauge.
- Layout state persists outside the installed payload so updates do not reset it.
- A persistent Node bridge serves snapshots to the Swift host and restarts on timeout or failure.

## Security boundary

The installer and runtime enforce these constraints:

1. Verify official Claude.app before installation.
2. Build a separate `Token Widget.app` with its own bundle identifier.
3. Require Accessibility permission for that companion application itself.
4. Inspect only roles and URLs during the shallow focused-window identity scan; read only exact Context-window button titles inside the selected web area for optional numerical enrichment.
5. Keep local transcript and cloud event-cache parsing content-discarding.
6. Never quit, relaunch, patch, inject into, or re-sign Claude.app.
7. Fail closed on missing permission, identity, telemetry, model-window data, or unsupported surfaces.

## Lifecycle

The per-user LaunchAgent is:

```text
com.sergiochan.token-meter.claude-desktop
```

It starts the native companion directly with absolute runtime, Node.js, Claude.app, and state paths. Unexpected non-zero exits are throttled. An Accessibility-blocked companion stays alive and checks the trust state quietly without repeating the system prompt or touching Claude.

Structured health state is accepted only while its PID is alive and its command is the exact installed executable followed by an argument boundary. Prefix lookalikes are rejected. Live Accessibility trust, UI readiness, bridge health, and exact Session binding remain distinct status fields.

Use:

```bash
./scripts/doctor-claude-meter-macos.sh
./scripts/install-claude-meter-macos.sh
./scripts/status-claude-meter-macos.sh --json
./scripts/uninstall-claude-meter-macos.sh
```

## Read-only development snapshot

An exact Session can be measured without UI or Accessibility:

```bash
npm run claude:snapshot -- \
  --desktop-session-id local_<desktop-session-uuid>
```

The CLI intentionally leaves the context denominator `null` because it has neither a focused Accessibility window nor permission to infer a window from model identity alone.

## Compatibility and remaining work

Local, remote, and SSH Code Sessions may expose different metadata and transcript availability. The current Beta support guarantee is for locally represented Sessions whose exact Desktop identity maps to local confirmed usage.

Future release validation should cover:

- Session switching with several simultaneously active Agents.
- Chat, Cowork, Settings, auxiliary, and multi-window transitions.
- Display arrangements above, below, and beside the primary display.
- Sleep/wake and login restoration.
- Claude Desktop upgrades that change Accessibility URLs, metadata, transcript, or model-catalog formats.

Unknown formats or surfaces must remain hidden or unbound until verified.
