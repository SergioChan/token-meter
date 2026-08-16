# Codex Desktop integration

> **Deprecated.** This CDP adapter is superseded by the native Token Widget
> overlay, which meters Codex by reading the active thread from Codex's local
> state (`~/.codex/state_5.sqlite`) and its rollout files — with no loopback
> debugging port, no launch flags, and no quit/relaunch of Codex. The adapter
> here still works but will be removed in a future release. See the repository
> README for the app install.

This integration injects the shared Token Widget runtime into the verified Codex Desktop renderer on macOS.

## Interface

The integration is reached through the repository-level commands:

```bash
./scripts/install-token-meter-macos.sh
./scripts/start-codex-meter-macos.sh --restart
./scripts/stop-codex-meter-macos.sh --restart
./scripts/uninstall-token-meter-macos.sh --restart
```

The persistent installer is the normal user path. The start and stop scripts are development controls.

The default installed runtime is `~/Library/Application Support/Token Meter/Codex Desktop/`. It is a sibling of, never a parent of, the Claude Desktop runtime. Set `TOKEN_METER_CODEX_INSTALL_ROOT` only when an explicit custom absolute path is required.

## Implementation

- `src/injector.mjs` verifies the signed OpenAI application, loopback CDP listener ownership, renderer semantics, and injected payload.
- `src/session-probe.mjs` resolves the exact selected Codex task UUID and fails closed when selection is ambiguous.
- `src/cdp-client.mjs` accepts loopback WebSocket endpoints only.
- `../../runtime/` contains the shared Shadow DOM meter. The Codex payload enables collapse, drag, and host-local layout persistence.
- `../../src/core/` contains host-independent aggregation, rate, baseline, and alert logic.

## Invariants

- Never inject into an unverified application, listener, or renderer surface.
- Never infer the selected task from rollout recency.
- Keep CDP bound to loopback.
- Do not modify, unpack, replace, or re-sign Codex.app.
- A normal Codex relaunch is allowed only through the documented installer recovery path; force-quit is never used.
