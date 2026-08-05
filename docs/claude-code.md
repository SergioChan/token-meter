# Claude Code Desktop Adapter Status

## Scope

Token Meter's Claude target is the **Code tab inside the Claude Desktop application**. The goal is a persistent lower-right graphical meter that follows the Session selected in the Desktop sidebar and moves as that Session's agent confirms new token usage.

The Claude Code CLI `statusLine` is explicitly out of scope for this adapter. It may be useful to other tools, but it does not satisfy the product requirement for an injected Desktop widget.

## Current status

Claude Code Desktop UI injection is **blocked by a production host authorization boundary**. The read-only measurement path is implemented. A fail-closed injector adapter is retained for a future supported authorization path, but it cannot enable CDP in the current public production application.

Implemented offline components:

- A macOS application verifier for the canonical path, bundle identifier, code signature, Anthropic Team ID, and executable.
- A bounded metadata index that resolves one exact Desktop `local_<uuid>` Session to one `cliSessionId` and fails closed on invalid, missing, or ambiguous identities.
- A bounded incremental transcript collector for the exact root transcript and every discovered child-Agent transcript under that Session.
- Response-level de-duplication that keeps one usage contribution per `message.id` and replaces an earlier partial snapshot when a later row updates the same response.
- Content-discarding root-turn, terminal, abort, and compaction boundaries.
- Shared Session, trailing-hour, current-turn, rate, historical baseline, alert, and child-Agent metrics.
- A development-only `claude-snapshot` command and Claude-specific unit fixtures.
- A fail-closed Code renderer probe derived from the installed application's `/code/<local_uuid>` route, active-link `aria-current`, and semantic Session-header marker.
- A dormant Claude injector adapter that verifies the signed application and listener process tree, rejects untrusted CDP targets, and registers the persistent script only after the semantic probe succeeds.

Anthropic documents the Code tab as Claude Code's graphical Desktop interface, with multiple parallel sessions managed in a sidebar. Desktop uses the same underlying engine as the CLI but maintains separate Session history.

Sources: [Use Claude Code Desktop](https://code.claude.com/docs/en/desktop) and [Desktop quickstart](https://code.claude.com/docs/en/desktop-quickstart).

## Confirmed local feasibility evidence

A read-only inspection of Claude Desktop for macOS on 2026-08-05 established the following version-specific facts:

- `/Applications/Claude.app` is an Electron application with bundle identifier `com.anthropic.claudefordesktop` and an Anthropic Developer ID signature.
- The Code tab starts a bundled Claude Code engine with structured streaming enabled and a distinct resume identifier for each running Session.
- Desktop Session metadata observed under `~/Library/Application Support/Claude/` contains both a Desktop-facing `sessionId` and an underlying `cliSessionId`.
- Matching Claude Code JSONL transcripts under `~/.claude/projects/` contain timestamped assistant usage objects with input, output, cache-read, and cache-creation token fields.
- The same response `message.id` can appear in several transcript rows. Root transcript samples repeated identical final usage, while child-Agent samples also contained partial-to-final usage updates. Summing rows would therefore materially overcount the workload.
- Multiple Claude Code Session processes can run concurrently, so process recency cannot identify the Session currently selected in the UI.

These observations demonstrate a plausible read-only identity and usage path. They are not public Anthropic APIs and must not be treated as stable contracts. Field names, paths, event semantics, and renderer structure may change between Desktop releases.

## Production injection blocker

Read-only inspection and isolated launch tests against Claude Desktop `1.24012.9` confirmed the following startup behavior:

1. The packaged main process scans its arguments before normal application initialization.
2. `--remote-debugging-port` and `--remote-debugging-pipe` cause the production process to exit.
3. The only observed exception requires both `CLAUDE_USER_DATA_DIR` and `CLAUDE_CDP_AUTH`.
4. `CLAUDE_CDP_AUTH` is bound to the exact user-data path, expires after five minutes, and must validate against an embedded Anthropic public key.
5. The application bundle contains the verifier but no public local signing path. Anthropic's public Desktop documentation does not describe a third-party CDP authorization flow.

Starting a second instance with an isolated profile does not remove this gate: the profile can be isolated, but the remote-debugging argument is rejected before that instance becomes usable. Restarting the user's main Claude process would hit the same check and would only interrupt active tasks.

Token Meter will not patch, copy, re-sign, or dynamically modify Claude.app, and it will not attempt to forge signed authorization. The injected UI target therefore remains blocked until Anthropic provides either a supported persistent host-UI extension surface or an official third-party CDP authorization flow.

## Adapter architecture

```text
Verified Claude Desktop main renderer
              |
              v
Exact selected Desktop Session identity
              |
              v
Desktop sessionId -> cliSessionId mapping
              |
              v
Bounded, content-discarding transcript collector
              |
              v
Shared MetricsEngine snapshot
              |
              v
Injected Shadow DOM Token Meter
```

The complete meter must switch atomically when the user selects another Desktop Session. A missing, invalid, or ambiguous Session identity must display an unbound state. The adapter must never fall back to the newest process, most recently modified transcript, or most recently active Session.

## Usage accounting requirements

The collector never sums raw transcript rows. It applies this response-level procedure:

1. Resolve the exact Desktop Session to its `cliSessionId` and project directory.
2. Read only that root transcript and the child-Agent transcripts nested under that Session.
3. Retain only response IDs, timestamps, event types, turn boundaries, and numerical usage fields.
4. Key assistant usage by `message.id`. Identical repeated rows contribute once; if a later row has updated usage for the same ID, it replaces the earlier snapshot.
5. Use the top-level response `usage` object and do not add its internal `iterations` breakdown again.
6. Add one confirmed raw-workload contribution per unique response:

```text
raw tokens = input_tokens
           + cache_creation_input_tokens
           + cache_read_input_tokens
           + output_tokens
```

Anthropic documents that `input_tokens` contains the uncached input after the final cache breakpoint, while cache creation and cache reads are reported separately. The total input processed is therefore their sum. See [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) and the [Messages usage reference](https://platform.claude.com/docs/en/api/messages/create).

This is a local raw-workload metric. It does not claim to reproduce Claude subscription-plan limits, API billing, or any undisclosed backend weighting.

For each selected Session, the adapter must produce:

- **Session:** confirmed cumulative token usage for the selected Session scope.
- **1H Session:** confirmed positive usage deltas timestamped within the trailing hour.
- **Current Turn:** confirmed positive deltas since the latest root user turn.
- **Rate:** confirmed positive deltas in the trailing 60-second window, normalized to tokens per minute.
- **Baseline and alert:** the same completed-turn historical model used by the Codex adapter.

Claude's active context occupancy is intentionally unavailable in the current offline adapter. Transcript response usage proves processed workload, but it does not expose a stable, documented per-Session context-window occupancy value equivalent to Codex's active-context telemetry. The adapter returns `null` instead of guessing.

The UI may animate between confirmed samples for responsiveness, but numerical totals must never invent unconfirmed usage.

## Read-only development snapshot

An exact local Session can be measured without restarting Claude or opening a debugging port:

```bash
npm run claude:snapshot -- \
  --desktop-session-id local_<desktop-session-uuid>
```

The Desktop identity is the `local_<uuid>` metadata filename under `~/Library/Application Support/Claude/claude-code-sessions/`. This command is a development and reconciliation surface, not the final user workflow; the injected adapter must obtain the selected identity from the verified renderer automatically.

## Injection and security boundary

The Claude adapter follows the Codex adapter's fail-closed principles while using Claude-specific identifiers and renderer markers:

1. Verify the exact application path, bundle identifier, code signature, and Anthropic signing Team ID.
2. Bind the Chromium debugging endpoint to `127.0.0.1` only.
3. Verify that the listener belongs to the expected Claude process tree.
4. Accept only the semantic Code-tab main renderer and reject settings, preview, quick-entry, and auxiliary surfaces.
5. Register persistent injection only after the live renderer probe passes.
6. Read only identifiers, timestamps, event type, and numerical usage fields; never retain prompt, reasoning, tool, or assistant content.
7. Never modify, unpack, replace, or re-sign the official Claude application bundle.
8. Remove injected DOM on shutdown and provide a normal restart path that closes the debugging port.

These are necessary adapter invariants, not a claim that a public launcher can currently satisfy the host's signed CDP prerequisite.

## Remaining live-validation work

The following items remain after—and only after—a supported host authorization path exists:

- The stable semantic marker for the currently selected Code Session.
- The correct main-renderer target and the rejection rules for every auxiliary window.
- Navigation behavior when moving between Chat, Cowork, and Code.
- Session switching across local, SSH, and remote environments.
- Resumed-Session behavior across Desktop upgrades and transcript relocation.
- Whether remote and SSH Sessions expose sufficient local confirmed usage for the same accounting guarantees.

No public Claude Desktop extension API currently documented by Anthropic provides a persistent arbitrary host-UI overlay. Desktop Extensions and Claude Code plugins expose MCP, skills, agents, hooks, and related capabilities; they are not a documented API for injecting a permanent widget into the Desktop shell. The planned overlay is therefore an unofficial, version-sensitive local compatibility adapter with an unmet host authorization prerequisite.

## Acceptance criteria

Claude Code Desktop support must not be marked complete until the repository provides:

1. A Claude-specific application verifier and safe macOS start/stop flow. The verifier is implemented; lifecycle flow is pending.
2. A semantic main-renderer and exact selected-Session probe. Implemented from static bundle evidence; live validation is blocked by host authorization.
3. A versioned Desktop `sessionId` to transcript identity resolver. Implemented for the inspected local metadata format.
4. A bounded, content-discarding, de-duplicating usage collector. Implemented for local root and child-Agent transcripts.
5. Session, trailing-hour, current-turn, rate, baseline, and alert metrics. Implemented for read-only local snapshots.
6. The injected lower-right meter with atomic Session switching. Injector code is implemented; live switching is blocked by host authorization.
7. Unit fixtures for duplicate, partial, resumed, reset, and unknown-Session cases.
8. Live tests covering Session switches, simultaneous Sessions, navigation, cleanup, and restart.
9. Accuracy reconciliation against known transcript usage samples.
10. Clear compatibility, privacy, uninstall, and recovery documentation.

Until every applicable criterion passes, the public support matrix must continue to say **Host-blocked for UI injection**.
