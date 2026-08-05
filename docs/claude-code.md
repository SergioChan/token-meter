# Claude Code Desktop Adapter Status

## Scope

Token Meter's Claude target is the **Code tab inside the Claude Desktop application**. The goal is a persistent lower-right graphical meter that follows the Session selected in the Desktop sidebar and moves as that Session's agent confirms new token usage.

The Claude Code CLI `statusLine` is explicitly out of scope for this adapter. It may be useful to other tools, but it does not satisfy the product requirement for an injected Desktop widget.

## Current status

Claude Code Desktop is **not supported by the current release**. The repository does not yet contain a Claude application verifier, renderer probe, injector, selected-Session resolver, transcript collector, installer, or Claude-specific live tests.

Anthropic documents the Code tab as Claude Code's graphical Desktop interface, with multiple parallel sessions managed in a sidebar. Desktop uses the same underlying engine as the CLI but maintains separate Session history.

Sources: [Use Claude Code Desktop](https://code.claude.com/docs/en/desktop) and [Desktop quickstart](https://code.claude.com/docs/en/desktop-quickstart).

## Confirmed local feasibility evidence

A read-only inspection of Claude Desktop for macOS on 2026-08-05 established the following version-specific facts:

- `/Applications/Claude.app` is an Electron application with bundle identifier `com.anthropic.claudefordesktop` and an Anthropic Developer ID signature.
- The Code tab starts a bundled Claude Code engine with structured streaming enabled and a distinct resume identifier for each running Session.
- Desktop Session metadata observed under `~/Library/Application Support/Claude/` contains both a Desktop-facing `sessionId` and an underlying `cliSessionId`.
- Matching Claude Code JSONL transcripts under `~/.claude/projects/` contain timestamped assistant usage objects with input, output, cache-read, and cache-creation token fields.
- Multiple Claude Code Session processes can run concurrently, so process recency cannot identify the Session currently selected in the UI.

These observations demonstrate a plausible read-only identity and usage path. They are not public Anthropic APIs and must not be treated as stable contracts. Field names, paths, event semantics, and renderer structure may change between Desktop releases.

## Planned architecture

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

Raw transcript events cannot be summed until their streaming and replay semantics are verified. The collector must prove how it handles partial messages, repeated message identifiers, resumed Sessions, retries, compaction, child agents, and counter resets.

For each selected Session, the adapter must produce:

- **Session:** confirmed cumulative token usage for the selected Session scope.
- **1H Session:** confirmed positive usage deltas timestamped within the trailing hour.
- **Current Turn:** confirmed positive deltas since the latest root user turn.
- **Rate:** confirmed positive deltas in the trailing 60-second window, normalized to tokens per minute.
- **Baseline and alert:** the same completed-turn historical model used by the Codex adapter.

The UI may animate between confirmed samples for responsiveness, but numerical totals must never invent unconfirmed usage.

## Injection and security boundary

The Claude adapter should follow the Codex adapter's fail-closed principles while using Claude-specific identifiers and renderer markers:

1. Verify the exact application path, bundle identifier, code signature, and Anthropic signing Team ID.
2. Bind the Chromium debugging endpoint to `127.0.0.1` only.
3. Verify that the listener belongs to the expected Claude process tree.
4. Accept only the semantic Code-tab main renderer and reject settings, preview, quick-entry, and auxiliary surfaces.
5. Register persistent injection only after the live renderer probe passes.
6. Read only identifiers, timestamps, event type, and numerical usage fields; never retain prompt, reasoning, tool, or assistant content.
7. Never modify, unpack, replace, or re-sign the official Claude application bundle.
8. Remove injected DOM on shutdown and provide a normal restart path that closes the debugging port.

## Remaining unknowns

The following items require a restart-approved live probe against Claude Desktop before implementation can be considered safe:

- The stable semantic marker for the currently selected Code Session.
- The correct main-renderer target and the rejection rules for every auxiliary window.
- Navigation behavior when moving between Chat, Cowork, and Code.
- Session switching across local, SSH, and remote environments.
- Exact de-duplication rules for streamed and resumed transcript usage events.
- Whether remote and SSH Sessions expose sufficient local confirmed usage for the same accounting guarantees.

No public Claude Desktop extension API currently documented by Anthropic provides a persistent arbitrary host-UI overlay. Desktop Extensions and Claude Code plugins expose MCP, skills, agents, hooks, and related capabilities; they are not a documented API for injecting a permanent widget into the Desktop shell. The planned overlay is therefore an unofficial, version-sensitive local compatibility adapter.

## Acceptance criteria

Claude Code Desktop support must not be marked complete until the repository provides:

1. A Claude-specific application verifier and safe macOS start/stop flow.
2. A semantic main-renderer and exact selected-Session probe.
3. A versioned Desktop `sessionId` to transcript identity resolver.
4. A bounded, content-discarding, de-duplicating usage collector.
5. Session, trailing-hour, current-turn, rate, baseline, and alert metrics.
6. The injected lower-right meter with atomic Session switching.
7. Unit fixtures for duplicate, partial, resumed, reset, and unknown-Session cases.
8. Live tests covering Session switches, simultaneous Sessions, navigation, cleanup, and restart.
9. Accuracy reconciliation against known transcript usage samples.
10. Clear compatibility, privacy, uninstall, and recovery documentation.

Until every applicable criterion passes, the public support matrix must continue to say **Not implemented**.
