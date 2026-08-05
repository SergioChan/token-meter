# Token Meter

Token Meter is an experimental, session-aware live token gauge for Codex Desktop. It mounts a small mechanical meter in the lower-right corner of the existing Codex renderer and reads token usage from local Codex rollout events.

## What the MVP shows

- **Session:** confirmed cumulative tokens for the selected root session and its known child agents.
- **1H Session:** confirmed tokens recorded for that session tree in the trailing hour.
- **Current Turn:** confirmed cumulative deltas since the latest root user message.
- **Rate:** confirmed deltas in a trailing 60-second window, normalized to tokens per minute.
- **Alert:** a conservative warning when the current rate is materially above a robust historical baseline.

The meter follows the exact UUID in Codex's active sidebar thread attribute. If it cannot bind that UUID to a known local rollout, it shows `SESSION UNKNOWN` instead of guessing.

## Important boundary

This is not a documented Codex host-UI plugin. Official Codex plugins can package skills and MCP capabilities, including tool-result UI, but they cannot mount a persistent widget in Codex Desktop chrome. The current UI adapter is an unofficial local CDP enhancement modeled on the architecture demonstrated by Codex Dream Skin.

Token Meter does not modify, unpack, re-sign, or replace the official application bundle.

## Requirements

- macOS.
- Codex Desktop installed as `/Applications/ChatGPT.app`, or `CODEX_APP_PATH` set to its bundle path.
- A current Codex build exposing the verified semantic thread attributes.
- Node.js 22.12 or newer. The macOS launcher uses Codex's bundled Node runtime.

## Verify the measurement core

```bash
npm test
npm run check
```

Read a session snapshot without injecting UI:

```bash
/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node \
  src/cli.mjs snapshot --thread-id <thread-uuid>
```

The parser retains numerical usage events and timing metadata only. It does not retain prompt, reasoning, tool, or assistant content.

## Preview the real renderer payload

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

Open [the component preview](http://127.0.0.1:4173/demo/preview.html). Its controls push confirmed mock snapshots through the same shadow-DOM runtime used by the Codex injector.

## Start the Codex MVP

Do not run the following while important Codex work is active. Enabling loopback CDP requires a Codex restart when the app is already running normally.

```bash
./scripts/start-codex-meter-macos.sh --restart
```

The launcher:

1. Verifies bundle identifier `com.openai.codex` and the bundled Node runtime.
2. Requests a normal Codex quit. It never force-quits the app.
3. Refuses a debugging port already owned by another process.
4. Relaunches Codex with CDP bound to `127.0.0.1` only.
5. Verifies that the listener belongs to the Codex application.
6. Injects only into a verified main `app://` renderer.

Press Control-C to stop the foreground injector and remove its UI. Restart Codex normally afterward to close the CDP port. A convenience cleanup is also available:

```bash
./scripts/stop-codex-meter-macos.sh --restart
```

## Measurement notes

- Codex confirms usage after an upstream model completion, not once per streamed token. Counters therefore move in truthful steps.
- `last_token_usage` is one model completion, not one user turn. Token Meter calculates the current turn from cumulative deltas.
- Cached input is a subset of input and is never added on top of total tokens.
- Child-agent rollouts share the root `session_id`; the compact meter includes them and shows `+N agents`.
- Historical comparisons use completed turns and robust statistics. Alerts are advisory and never interrupt Codex.

## Current limitations

- The Codex DOM and rollout format are version-sensitive compatibility surfaces.
- The active Session loads first. Historical baselines warm incrementally and may show `Learning` for the first few samples.
- The MVP is macOS-first.
- Claude Code support is designed but not implemented. The intended official path is OpenTelemetry aggregation plus Claude Code's native status line.
- The injector is not currently distributed as a signed native macOS controller.

See [the feasibility study](docs/research/codex-token-meter-feasibility.md) and [architecture decisions](docs/architecture.md) for details.
