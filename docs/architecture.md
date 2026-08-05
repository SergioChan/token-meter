# Token Meter Architecture

## Decision

Token Meter is a local desktop enhancement with a small core and host adapters. The core knows nothing about Codex DOM selectors or Claude UI. Each host adapter must provide two things:

1. Exact active-session identity.
2. Confirmed token-usage events and turn boundaries.

The first implementation uses Codex rollout JSONL as a read-only compatibility adapter and loopback CDP as an unofficial UI adapter.

Current host support:

- Codex Desktop on macOS: implemented.
- Claude Code in Claude Desktop on macOS: adapter contract documented, implementation absent.
- Codex Desktop on Windows and Linux: implementation absent.

## Modules

```text
RolloutStore
  incremental bounded reads
  content-discarding event parser
        |
        v
MetricsEngine
  session-tree aggregation
  root-thread active context
  rolling windows
  current-turn delta
  historical baseline and anomaly level
        |
        v
CodexInjector
  exact active-thread probe
  main-renderer validation
  shadow-DOM UI updates
```

The seam between the core and a host adapter is the snapshot shape returned by `MetricsEngine`. A future Claude Desktop collector can satisfy the same shape from confirmed transcript usage events without changing the meter's measurement semantics.

## Invariants

- A requested but unknown thread produces `status: "unbound"`; it never falls back to another thread.
- Session totals include every loaded rollout with the same root `session_id`.
- Cached input is retained as a breakdown but is not added on top of total tokens.
- Cumulative Session usage never decreases on compaction; active Context comes from the latest root-thread `last_token_usage` and may decrease.
- A `context_compacted` event is retained only as a timestamp; no compacted summary or conversation content is retained.
- Current-turn usage is a cumulative delta since the latest root user message, not `last_token_usage`.
- All rolling-window calculations sum positive cumulative deltas and tolerate counter resets.
- Prompt, reasoning, tool, and assistant content are never retained by the parser.
- Numerical UI values move only toward locally reported snapshots; no per-token stream is fabricated between host updates.
- CDP connections are loopback-only and main-renderer-only.
- The official Codex bundle path, bundle ID, code signature, and signing Team ID are verified before attachment.
- A renderer must pass the semantic probe before any persistent injection script is registered.

## Session switching

The Codex adapter polls the verified semantic active-thread attribute once per second. When the UUID changes, it requests a snapshot for the new root thread and atomically updates the entire meter. A missing or invalid UUID produces an unbound card. Child rollouts are indexed by root Session identity even when they were created in a later date directory. A recursive filesystem watcher invalidates the rollout index when a new child appears; the ten-second discovery interval remains a fallback rather than the normal update path.

## Session versus thread

Codex descendants have their own thread IDs but share the root session ID. The default compact meter shows the session tree because background agents are part of the user's consumption and are central to the stated failure mode. The UI shows `+N agents` to make that aggregation explicit.

## Raw workload versus active context

The cumulative Session meter and the active Context meter answer different questions. Session usage sums positive cumulative-token deltas across the root and child Agents. It is a raw workload counter: every reported request counts its full input total, including the cached-input subset exactly once. It represents confirmed model processing and does not decrease when Codex compacts history.

Active Context is scoped to the selected root thread because every child Agent has its own independent context window. It uses the latest Codex-reported `last_token_usage.total_tokens` and `model_context_window`. A compaction event can therefore reduce active Context while cumulative Session usage remains unchanged. The snapshot also exposes root-thread compaction count and latest compaction time.

Neither metric claims to reproduce the backend account activity shown by Codex `/usage`.

## Account-usage boundary

The App Server's `account/usage/read` method has no parameters and returns an account summary plus optional daily buckets. It exposes no thread, Session, turn, model, input, cached-input, or output attribution. Conversely, `thread/tokenUsage/updated` and rollout `token_count` events expose raw thread usage but not the backend account weighting used by `/usage`.

Token Meter therefore does not infer an exact per-Session backend number. Account deltas cannot be assigned safely when Sessions, child Agents, other devices, or delayed backend aggregation overlap. The meter retains raw workload because repeated cached requests are still useful evidence of agent intensity and runaway loops, while documentation and UI must not call that reading an account bill or `/usage` equivalent.

## macOS lifecycle controller

The source installer copies the minimal runtime into the user's Application Support directory and loads a per-user LaunchAgent. The controller waits for Codex instead of opening it at login. A normal Dock launch without loopback CDP receives at most one normal quit/relaunch attempt for that process. Failed verification, an occupied port, a failed normal quit, or a failed relaunch all fail closed without a force-quit or relaunch loop.

The controller remains alive across later Codex launches and sleep/wake. `RunAtLoad` restores it after login; launchd does not use `KeepAlive`, so an unexpected controller crash cannot become a launchd crash loop. Re-running the installer refreshes the copied runtime and restarts the controller without modifying the official application bundle.

## Alert model

Historical completed-turn rates are summarized by median, mean, p95, and median absolute deviation. The initial classifier is deliberately conservative and has a learning state until at least five completed historical turns, 20 seconds of current activity, and 10,000 current-turn tokens are present.

Alerts are advisory. Token Meter never interrupts Codex, kills an agent, or creates a new session automatically.

## Compatibility policy

Desktop injection is version-sensitive. Supporting a Codex release requires:

- An exact active-thread UUID probe.
- Main-renderer marker verification.
- Auxiliary-renderer rejection.
- Runtime syntax and idempotency checks.
- A live navigation and cleanup smoke test.
- A persistent-controller login load, normal-launch recovery, and one-attempt failure check.

Unknown builds fail closed until verified.

The latest live validation recorded in this repository used Codex Desktop `26.730.61639 (6234)` on macOS.

## Claude Desktop adapter boundary

The Claude target is the Code tab inside Claude Desktop, not the Claude Code CLI status line. It can reuse the measurement and Shadow DOM presentation layers, but not the Codex Session probe, rollout reader, application verifier, or renderer allowlist.

The planned macOS adapter has three host-specific responsibilities:

1. Verify the official Claude application, loopback debugging listener, process ownership, and semantic main renderer before injection.
2. Read the exact Session selected in the Desktop UI and map its Desktop identity to the underlying Claude Code transcript identity.
3. Convert confirmed, de-duplicated transcript usage events into the shared snapshot model without retaining message content.

Observed Desktop metadata and transcript formats are undocumented compatibility surfaces. Missing or ambiguous identity, remote-only telemetry, an unknown renderer, or an unsupported build must produce an unbound meter rather than a guessed Session. See [claude-code.md](claude-code.md).
