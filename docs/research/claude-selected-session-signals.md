# Claude Desktop Selected-Session Signals on macOS

## Scope

This note evaluates whether an external macOS Token Meter can identify the
**currently selected Claude Code Session inside the stock Claude Desktop app**.
It separates three different questions that are easy to conflate:

1. Which Desktop Sessions exist?
2. Which Claude Code engines are running or producing events?
3. Which Desktop Session is selected in the visible Code UI right now?

Static storage, process, and source inspection was read-only. Live validation
briefly activated Claude and used the documented next/previous Session
shortcuts, then restored the original Session and foreground application. It
did not restart, quit, stop, prompt, or type into a Claude Session, and it did
not inspect conversation text, credentials, cookies, OAuth material, or raw
prompts. Identifiers below are represented only by structural forms such as
`local_<uuid>` and `<cli-uuid>`.

## Bottom line

The exact selected Desktop Session ID is available on this installation, but
not from the CLI process list or transcript directory alone:

| Signal | What it proves | Classification |
| --- | --- | --- |
| `AXWebArea.AXURL` ending in `/epitaxy/local_<uuid>` | The exact Session rendered by that Claude window | **Exact for the tested main Code surface** |
| `claude-code-sessions/**/local_<uuid>.json` | Exact `local_<uuid>` to `<cli-uuid>` mapping | **Exact identity mapping; not selection** |
| `~/.claude/sessions/<pid>.json` | Exact live process to `<cli-uuid>` mapping | **Exact process mapping; not selection** |
| Claude Code hook input `session_id` | Exact Session that emitted a hook event | **Exact event attribution; not selection** |
| Metadata `lastFocusedAt` | The most recent time Desktop reported a Session visible | **Strong conditional fallback; not current-state proof** |
| Metadata `lastActivityAt`, metadata file `mtime`, newest transcript | Recent agent work or persistence | **Heuristic and unsafe for selection** |
| Bundled CLI `--resume <cli-uuid>` argument | Resume identity for some running processes | **Partial enumeration; not selection** |
| Session/Local Storage and IndexedDB remnants | Draft, pin, and other renderer state observed in this profile | **Not a validated selected-Session signal** |
| `window-state.json` | Window geometry only | **Absent** |

The recommended identity chain is therefore:

```text
Claude window AXWebArea.AXURL
  -> exact local_<uuid>
  -> Desktop metadata file
  -> exact cliSessionId + cwd
  -> exact transcript and live usage collector
```

No title matching is needed. The Accessibility result contains the stable
Desktop ID, not merely the visible Session name.

## Tested installation

The live inspection used:

- Claude Desktop `1.24012.9`
- bundle identifier `com.anthropic.claudefordesktop`
- `/Applications/Claude.app/Contents/Resources/app.asar`
- `app.asar` SHA-256
  `47239ac1726455a06cfe6dddb7f46a03629b718db3f8f4b688524f8409560bce`
- bundled Claude Code `2.1.219`

All conclusions about private paths, schemas, renderer routes, and packaged
implementation are version-specific observations, not public compatibility
contracts from Anthropic.

## 1. Exact selected identity from the Accessibility URL

A read-only Accessibility scan of the running Claude process found an
`AXWebArea` whose `AXURL` had this shape:

```text
https://claude.ai/epitaxy/local_<uuid>
```

The `local_<uuid>` component matched exactly one Desktop metadata record. That
record contained a valid `cliSessionId`, and Token Meter's existing
`claude-snapshot` path resolved it as an exact bound Session with numerical
Session, trailing-hour, current-turn, and rate metrics.

A controlled Session switch changed the `AXURL` from one `local_<uuid>` to a
different `local_<uuid>`. Switching back restored the original ID. This proves
that, for the tested main Code surface, the AX URL follows Session selection
rather than merely identifying the application or showing a human-readable
title.

The route is `/epitaxy/local_<uuid>` in the installed build. An adapter must not
hard-code only the previously inferred `/code/local_<uuid>` form; it should use
a versioned allowlist of observed Code-route templates and still require a
valid `local_<uuid>`.

### Limits of the AX result

This exact result has been validated for the current main Code window. The
adapter must still fail closed until separately tested for:

- multiple Claude windows;
- split layouts that can make more than one Session visible;
- Chat, Cowork, settings, preview, quick-entry, and auxiliary windows;
- SSH and cloud Sessions whose identity or transcript may not be fully local;
- future Desktop route changes.

An AX element without a recognized route and valid ID must produce an unbound
meter. A Session title is not a safe fallback.

## 2. What the packaged app records internally

The packaged main process has two relevant renderer-to-main signals.

### Visibility updates persist `lastFocusedAt`

In the installed `app.asar`, `setSessionVisibility(sessionId, isVisible,
reason)` records a visibility event. When `isVisible` is true, it performs the
equivalent of:

```js
session.lastFocusedAt = Date.now();
saveSession(session);
```

This explains why the metadata record corresponding to the live AX ID was the
unique maximum by `lastFocusedAt` during the snapshot.

It does **not** make `lastFocusedAt` an authoritative selected-state field:

- it is a historical timestamp, not an `isSelected` boolean;
- it remains after Claude loses focus, changes surface, or exits;
- the method is named and driven as visibility, which may differ from keyboard
  focus in multi-pane or multi-window layouts;
- several visible Sessions can have recent timestamps;
- a crash can leave the last persisted value stale.

It is useful for candidate ordering and diagnostics, but a production meter
should not silently bind from `max(lastFocusedAt)` alone.

### The exact focused ID also exists in main-process memory

The packaged Local Sessions API exposes a renderer call named
`setFocusedSession(sessionId)`. Its implementation stores the exact ID in a
main-process variable and updates macOS Handoff state where applicable.

No supported external getter or durable file containing that current in-memory
value was found. Reading another process's memory or invoking private Electron
IPC is not an acceptable plugin boundary. This internal signal does, however,
corroborate that the renderer itself knows the exact Session ID and that the AX
route is exposing the same identity at the window boundary.

## 3. Exact local identity sources that do not prove selection

### Desktop Session metadata

Stock Desktop writes one record per local Code Session under:

```text
~/Library/Application Support/Claude/claude-code-sessions/
  <account-scope>/<organization-scope>/local_<uuid>.json
```

The observed schema includes these useful fields:

```text
sessionId        local_<uuid>
cliSessionId     <cli-uuid>
cwd              absolute project/worktree path
createdAt        timestamp
lastActivityAt   timestamp
lastFocusedAt    timestamp
isArchived       boolean
```

This is the exact bridge from the Desktop-facing ID to the underlying Claude
Code identity. It is not a selected-Session pointer: every retained Session has
a record.

### Live Claude Code process registry

Each running bundled Claude Code engine observed on this machine had a
read-only registry record under:

```text
~/.claude/sessions/<pid>.json
```

The schema includes `pid`, `procStart`, `sessionId`, `cwd`, `entrypoint`, and
version fields. `sessionId` is a valid `<cli-uuid>`, so this file gives an exact
process-to-Session mapping even when a newly started process has no `--resume`
argument.

This registry answers "which engines are alive?" It cannot answer "which one
is selected?" Multiple registered engines remained alive concurrently under
the same Claude Desktop parent process.

### Process arguments

Resumed engines were launched with `--resume <cli-uuid>`. Newly created engines
did not necessarily include `--resume` or `--session-id`; their exact identity
was still available in `~/.claude/sessions/<pid>.json`.

Process arguments are therefore incomplete even for enumeration, and all
concurrent engines share the same Desktop parent. Recency, PID order, CPU use,
or presence of `--resume` cannot prove which sidebar Session is selected.

Anthropic's CLI reference documents that `--resume` accepts a Session ID or
name and that `--session-id` assigns a UUID. The Session-management guide also
states that local Sessions are saved continuously and can be resumed by ID.
See [CLI reference](https://code.claude.com/docs/en/cli-usage) and
[Manage sessions](https://code.claude.com/docs/en/sessions).

### Transcripts

The exact `<cli-uuid>` maps to Claude Code JSONL under the corresponding encoded
project directory in:

```text
~/.claude/projects/<encoded-project>/<cli-uuid>.jsonl
```

This is sufficient for exact usage attribution after the Desktop-to-CLI mapping
is known. File modification time only proves that a Session wrote something;
background Sessions can continue writing while a different Session is visible.

### Hooks

Claude Code hooks receive an exact `session_id`, `transcript_path`, and `cwd` on
each hook event. A non-blocking hook can therefore provide low-latency lifecycle
and activity events for every Session. Anthropic documents these fields in the
[Hooks reference](https://code.claude.com/docs/en/hooks).

Hooks still do not emit a documented "Desktop sidebar selection changed"
event. A background Session can produce hooks while another Session is selected,
and selecting an idle Session need not fire a hook. Hooks are an excellent
activity source, not a selected-window resolver.

## 4. Why activity and filesystem recency are unsafe

During the live snapshot, the Session identified by the AX URL was:

- the unique most recent record by `lastFocusedAt`;
- **not** the most recent record by `lastActivityAt`;
- **not** the most recently modified metadata file;
- observed while other Claude Code engines were still running.

This is the failure mode Token Meter must handle: the selected Session and the
hardest-working background Session can be different. Binding to the newest
transcript, newest metadata file, highest CPU process, or newest
`lastActivityAt` would display another Session's meter.

## 5. Other stores inspected

The following paths did not provide a validated current selected-Session
pointer:

| Path | Observation |
| --- | --- |
| `window-state.json` | Window bounds and fullscreen state only |
| `~/Library/Logs/Claude/` | No structural `selectedSessionId`, `activeSessionId`, or `/code/local_` marker found in the inspected logs |
| Chromium Session Storage | Contained a `local_<uuid>` as a storage key, including stale/deleted history; no selected-state semantics established |
| Chromium Local Storage | Contained per-Session draft/state records and historical UUIDs; activity/persistence records were not a unique current pointer |
| Claude IndexedDB | The inspected matching record was a pin-state key (`store:pin-state:dframe-starred-code`), not current selection |
| `plan-usage-history.json` | Shared plan-usage samples, no Desktop Session identity |

Raw Chromium stores also retain historical records and tombstones. A UUID found
with `strings` or `rg` is not evidence that it is current; the record key and
active LevelDB sequence must be decoded before assigning meaning.

## 6. Recommended Token Meter resolver

Use this resolver priority:

1. **Primary — exact:** read the eligible Claude window's
   `AXWebArea.AXURL`. A recognized route containing one valid `local_<uuid>` is
   the exact selected Session for the tested surface.
2. **Fallback — strong but conditional:** when there is exactly one eligible,
   frontmost Claude Code window, use the unique maximum `lastFocusedAt` as a
   short-lived fallback. The installed source explicitly stamps it when
   visibility becomes true. Reject ties, stale values, multiple windows,
   non-Code surfaces, and split-layout ambiguity.
3. **Attribution only:** use hooks, `~/.claude/sessions/<pid>.json`, process
   arguments, and transcripts to enumerate engines and attribute workload.
   None of them proves UI selection.
4. **Diagnostics only:** treat `lastActivityAt`, metadata `mtime`, transcript
   `mtime`, PID recency, and CPU use as heuristics. Never select a Session from
   them.

Once the selected Desktop ID is known, use a two-layer identity design:

1. **Window binding:** read the frontmost eligible Claude window's recognized
   `AXWebArea.AXURL` and extract exactly one `local_<uuid>`.
2. **Usage binding:** resolve that Desktop ID through the metadata record to the
   exact `<cli-uuid>` and transcript collector.

Supplement, but do not replace, the exact window binding with:

- a file watcher over Desktop metadata to prewarm Session mappings;
- `lastFocusedAt` for candidate ranking and diagnostics;
- `~/.claude/sessions/<pid>.json` for live-process status;
- hooks and transcript deltas for low-latency activity and token updates.

The meter should become unbound when the Claude window is not on a recognized
Code route, the AX URL has no valid ID, the metadata mapping is missing or
ambiguous, or the transcript identity cannot be validated. It must never fall
back to a Session title, newest process, or newest file.

A native overlay using this resolver was launched as a separate process during
the experiment without restarting Claude. That confirms the display approach
does not require taking down existing agents; it does not yet establish the
multi-window compatibility cases listed above.

## 7. Exact active-context numerator and window size

The selected root transcript's latest assistant `message.usage` record contains
`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and
`output_tokens`. Summing the three input-side fields produced an exact local
value that rounded to the same `596.0k` shown by Claude Desktop during the
validation. Output tokens were not included in that numerator.

This matches Anthropic's documented status-line semantics:

- `context_window.total_input_tokens` is current context usage from the most
  recent API response, not cumulative Session usage;
- input includes fresh input, cache creation, and cache reads;
- `used_percentage` uses input-side tokens only; and
- after compaction, current usage is unavailable until the next API response.

See [Customize your status line](https://code.claude.com/docs/en/statusline#available-data).

The transcript does not record `context_window_size`. On the tested Desktop
surface, Accessibility exposed the formatted ratio on both an `AXButton` title
and an `AXStaticText` value, with the shape:

```text
596.0k / 1.0M
```

The native overlay can therefore combine the exact transcript numerator with
the AX denominator. It must keep the denominator unavailable when that
recognized ratio is absent; model-name inference is not an exact substitute.

## Reproducible read-only checks

These commands expose schemas and structural markers without printing prompts,
responses, credentials, or raw identifiers.

```bash
# Installed versions and bundle fingerprint.
defaults read /Applications/Claude.app/Contents/Info \
  CFBundleShortVersionString
shasum -a 256 /Applications/Claude.app/Contents/Resources/app.asar

# Confirm the packaged visibility/focus APIs exist. Redact UUIDs if output is
# retained in a report.
rg -a -o '.{0,120}setSessionVisibility.{0,320}' \
  /Applications/Claude.app/Contents/Resources/app.asar
rg -a -o '.{0,120}setFocusedSession.{0,320}' \
  /Applications/Claude.app/Contents/Resources/app.asar

# Inspect only metadata key names, never values.
find "$HOME/Library/Application Support/Claude/claude-code-sessions" \
  -type f -name '*.json' -print0 |
  xargs -0 jq -r 'keys[]' | sort -u

# Inspect only live-registry key names and value types.
find "$HOME/.claude/sessions" -maxdepth 1 -type f -name '*.json' -print0 |
  xargs -0 jq -r 'to_entries[] | "\(.key)\t\(.value|type)"' |
  sort -u

# List bundled Claude Code flag names without exposing argument values.
ps -axo pid=,comm= |
  awk '/Application Support\/Claude\/claude-code\/.*\/MacOS\/claude$/ {print $1}' |
  while read -r pid; do
    ps -ww -p "$pid" -o command= |
      tr ' ' '\n' |
      awk '/^--[A-Za-z0-9_-]+(=|$)/ {sub(/=.*/, ""); print}'
  done | sort -u
```

The AX probe should similarly return only the role, URL route template, and a
redacted or one-way-hashed ID during diagnostics. It should never dump the full
Accessibility text tree because that can contain conversation content.

## Primary references

- [Use Claude Code Desktop](https://code.claude.com/docs/en/desktop) documents
  the Code tab, parallel sidebar Sessions, per-Session context, and the fact
  that Desktop and CLI can run simultaneously with separate history.
- [Manage sessions](https://code.claude.com/docs/en/sessions) documents local
  transcript persistence and resume-by-ID behavior.
- [CLI reference](https://code.claude.com/docs/en/cli-usage) documents
  `--resume` and UUID-based `--session-id`.
- [Hooks reference](https://code.claude.com/docs/en/hooks) documents the exact
  `session_id`, `transcript_path`, and `cwd` fields supplied to hook events.
- Installed Claude Desktop `1.24012.9` `app.asar` and the redacted local schemas
  above are the primary evidence for private implementation details.
