# Codex Desktop Integration

This integration injects the shared Token Meter runtime into the verified Codex Desktop renderer on macOS.

## Interface

The integration is reached through the repository-level commands:

```bash
./scripts/install-token-meter-macos.sh
./scripts/start-codex-meter-macos.sh --restart
./scripts/stop-codex-meter-macos.sh --restart
./scripts/uninstall-token-meter-macos.sh --restart
```

The persistent installer is the normal user path. The start and stop scripts are development controls.

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
