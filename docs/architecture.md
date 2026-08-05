# Token Meter Architecture

## Decision

Token Meter is a local desktop enhancement with a small core and host adapters. The core knows nothing about Codex DOM selectors or Claude UI. Each host adapter must provide two things:

1. Exact active-session identity.
2. Confirmed token-usage events and turn boundaries.

The first implementation uses Codex rollout JSONL as a read-only compatibility adapter and loopback CDP as an unofficial UI adapter.

Current host support:

- Codex Desktop on macOS: implemented.
- Claude Code: adapter contract documented, implementation absent.
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

The seam between the core and a host adapter is the snapshot shape returned by `MetricsEngine`. A future Claude collector can satisfy the same shape from OpenTelemetry without changing the meter's measurement semantics.

## Invariants

- A requested but unknown thread produces `status: "unbound"`; it never falls back to another thread.
- Session totals include every loaded rollout with the same root `session_id`.
- Cached input is retained as a breakdown but is not added on top of total tokens.
- Current-turn usage is a cumulative delta since the latest root user message, not `last_token_usage`.
- All rolling-window calculations sum positive cumulative deltas and tolerate counter resets.
- Prompt, reasoning, tool, and assistant content are never retained by the parser.
- Numerical UI values move only toward confirmed snapshots.
- CDP connections are loopback-only and main-renderer-only.
- The official Codex bundle path, bundle ID, code signature, and signing Team ID are verified before attachment.
- A renderer must pass the semantic probe before any persistent injection script is registered.

## Session switching

The Codex adapter polls the verified semantic active-thread attribute once per second. When the UUID changes, it requests a snapshot for the new root thread and atomically updates the entire meter. A missing or invalid UUID produces an unbound card. Child rollouts are indexed by root Session identity even when they were created in a later date directory. A recursive filesystem watcher invalidates the rollout index when a new child appears; the ten-second discovery interval remains a fallback rather than the normal update path.

## Session versus thread

Codex descendants have their own thread IDs but share the root session ID. The default compact meter shows the session tree because background agents are part of the user's consumption and are central to the stated failure mode. The UI shows `+N agents` to make that aggregation explicit.

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

Unknown builds fail closed until verified.

The latest live validation recorded in this repository used Codex Desktop `26.730.61639 (6234)` on macOS.

## Claude Code adapter boundary

Claude Code cannot reuse the Codex UI or rollout adapters. It requires an OpenTelemetry collector keyed by `session.id` and `prompt.id`, plus a native status-line renderer and an explicit settings installation step. See [claude-code.md](claude-code.md).
