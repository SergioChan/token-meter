# Codex Token Meter Feasibility Study

**Date:** 2026-08-04  
**Scope:** Codex Desktop first; Claude Code as a follow-on target

Reference revisions:

- [Codex Dream Skin `0a727a5`](https://github.com/Fei-Away/Codex-Dream-Skin/tree/0a727a539fc9cd298ad4827c6cefbd4a2192db79)
- [OpenAI Codex `30d9923`](https://github.com/openai/codex/tree/30d99232f485bd64eda9f6e0d9433bceebb2cb2b)

## Executive summary

A persistent Token Meter in the lower-right corner of the existing Codex Desktop interface is feasible, but it is not supported by the documented Codex plugin UI surface. The practical MVP therefore needs two independent mechanisms:

1. A local, read-only collector that tails trusted token-usage events and maintains session, rolling-hour, per-turn, rate, and historical anomaly state.
2. An unofficial Chromium DevTools Protocol (CDP) injector, modeled on Codex Dream Skin, that mounts a small shadow-DOM meter in the existing renderer.

The main engineering risk is exact session binding, not drawing the meter. The meter must use the complete thread UUID exposed by the active Codex sidebar row or route. It must never infer the active session from the newest rollout file because background agents, automations, inactive tasks, and other windows can all write concurrently.

Token updates are stepwise rather than token-by-token. Codex confirms usage after an upstream model completion. The UI may animate a number or needle between the old and new confirmed values, but it must not fabricate token growth between samples.

## 1. What Codex Dream Skin demonstrates

Dream Skin is an external desktop enhancement, not a documented Codex UI plugin. It states that it uses local CDP injection and does not modify the official `.app`, `app.asar`, or code signature ([README](https://github.com/Fei-Away/Codex-Dream-Skin/blob/0a727a539fc9cd298ad4827c6cefbd4a2192db79/README.en.md#L7-L24)).

On macOS it discovers the application through bundle identifier `com.openai.codex`, validates the app and bundled Node runtime, and supports both `ChatGPT.app` and legacy `Codex.app` layouts ([bundle discovery](https://github.com/Fei-Away/Codex-Dream-Skin/blob/0a727a539fc9cd298ad4827c6cefbd4a2192db79/macos/scripts/common-macos.sh#L237-L335)). It relaunches the official app with a debugging listener bound to `127.0.0.1` ([launch implementation](https://github.com/Fei-Away/Codex-Dream-Skin/blob/0a727a539fc9cd298ad4827c6cefbd4a2192db79/macos/scripts/common-macos.sh#L837-L855)).

Its injector:

- Accepts loopback CDP WebSocket URLs only.
- Filters `app://` page targets.
- Enables the `Runtime` and `Page` domains.
- Probes expected Codex shell markers.
- Executes a renderer payload with `Runtime.evaluate`.
- Registers an early script and reinjects after renderer reloads.

The implementation is in [`injector.mjs`](https://github.com/Fei-Away/Codex-Dream-Skin/blob/0a727a539fc9cd298ad4827c6cefbd4a2192db79/macos/scripts/injector.mjs#L347-L577) and its [watch loop](https://github.com/Fei-Away/Codex-Dream-Skin/blob/0a727a539fc9cd298ad4827c6cefbd4a2192db79/macos/scripts/injector.mjs#L1900-L2070). The renderer uses constructable stylesheets with a `<style>` fallback and repairs itself after SPA route or DOM changes ([CSS installation](https://github.com/Fei-Away/Codex-Dream-Skin/blob/0a727a539fc9cd298ad4827c6cefbd4a2192db79/runtime/renderer-inject.js#L501-L545), [repair loop](https://github.com/Fei-Away/Codex-Dream-Skin/blob/0a727a539fc9cd298ad4827c6cefbd4a2192db79/runtime/renderer-inject.js#L764-L865)).

The reusable pattern is:

- Keep all modifications in a user-space controller and renderer payload.
- Mount one fixed-position shadow-DOM host.
- Keep selectors in a small versioned compatibility contract.
- Verify the renderer before injection and fail closed on an unknown build.
- Provide complete cleanup without patching the application bundle.

Dream Skin's changelog shows real maintenance risk: Codex shell markers, settings DOM, native CDP behavior, and CSS selector compatibility have changed across releases ([26.727 fixes](https://github.com/Fei-Away/Codex-Dream-Skin/blob/0a727a539fc9cd298ad4827c6cefbd4a2192db79/macos/CHANGELOG.md#L3-L14), [26.721 fixes](https://github.com/Fei-Away/Codex-Dream-Skin/blob/0a727a539fc9cd298ad4827c6cefbd4a2192db79/macos/CHANGELOG.md#L46-L69)).

## 2. Official Codex extension boundary

The documented Codex plugin architecture contains skills, an optional MCP server, or both. An MCP server can return an optional MCP Apps UI resource associated with a tool result ([Plugin architecture](https://developers.openai.com/plugins/concepts/plugins), [MCP UI](https://developers.openai.com/plugins/build/chatgpt-ui)).

No documented contribution point allows a plugin to mount a permanent widget in Codex Desktop chrome, access the renderer DOM, or subscribe to the desktop frontend's selected-thread state. Codex App Server is the supported interface for building a separate rich client, not for extending the existing desktop renderer ([App Server](https://learn.chatgpt.com/docs/app-server)).

The product must therefore describe the current implementation accurately as a local desktop enhancement or companion. A conventional `.codex-plugin/plugin.json` package can later distribute related skills or tools, but it cannot create the requested lower-right meter by itself.

## 3. Token data sources

### 3.1 App Server

The strongest structured event is `thread/tokenUsage/updated`. It includes `threadId`, `turnId`, total usage, latest completion usage, and model context-window size. Token breakdowns include total, input, cached input, output, and reasoning output fields ([protocol definition](https://github.com/openai/codex/blob/30d99232f485bd64eda9f6e0d9433bceebb2cb2b/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1576-L1635)).

This is the preferred source for a client that owns its App Server connection. It does not provide a documented way to subscribe to the private stdio App Server process already owned by Codex Desktop.

### 3.2 Rollout JSONL

Codex persists rollouts under:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl
```

The path layout and `TokenCount` persistence are present in the open-source implementation ([rollout listing](https://github.com/openai/codex/blob/30d99232f485bd64eda9f6e0d9433bceebb2cb2b/codex-rs/rollout/src/list.rs#L420-L423), [persistence policy](https://github.com/openai/codex/blob/30d99232f485bd64eda9f6e0d9433bceebb2cb2b/codex-rs/rollout/src/policy.rs#L85-L104)).

A read-only sidecar can retain only:

- Thread and session IDs.
- Root/subagent relationship metadata.
- User-turn timestamps.
- Token-count timestamps and numerical breakdowns.

It must discard prompt text, reasoning, tool output, and assistant content. Rollout JSONL remains a version-sensitive compatibility source rather than a guaranteed public API.

### 3.3 OpenTelemetry

Codex can export per-turn token usage through OpenTelemetry ([observability configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry)). OTel is useful for durable historical analysis, but batching and the lack of desktop selected-thread state make it a weaker live UI feed.

### 3.4 Rejected primary sources

- Rate-limit percentages are too coarse.
- `account/usage/read` exposes summaries and daily buckets, not a live hourly stream.
- DOM text is rounded presentation data.
- Local storage and frontend stores are private and version-sensitive.
- Provider-response interception is invasive and unnecessary.

## 4. Measurement semantics

### Session total

Input tokens already include cached input. Cached input is a subset and must not be added again. The compact UI can show total throughput while retaining each breakdown internally.

For this product, **Session** means the selected root session tree: the root thread plus descendants that share its `session_id`. This choice is intentional because the stated problem includes background-agent consumption and agent self-contention. The UI shows the descendant count so the aggregation is not hidden.

### Current turn

`tokenUsage.last` is one upstream completion, not one user message. A tool-using turn can contain several completions ([completion handling](https://github.com/openai/codex/blob/30d99232f485bd64eda9f6e0d9433bceebb2cb2b/codex-rs/core/src/session/turn.rs#L2498-L2542)). Current-turn usage is therefore the sum of positive cumulative deltas since the latest root user-message boundary, including known descendants in the same session tree.

### Rolling hour

Codex provides no native rolling-hour number. The collector maintains confirmed positive deltas with timestamps. The compact meter shows the selected Session's rolling hour; expanded details may show all-session usage.

### Rate

The initial rate is confirmed tokens in a trailing 60-second window, normalized to tokens per minute. The numerical total changes only after confirmed usage events. The needle may animate to the new rate and decay when confirmed deltas leave the trailing window.

## 5. Exact selected-session binding

The current Codex Desktop build inspected locally is `26.727.51351 (6119)`. Its renderer bundle exposes semantic attributes:

```text
data-app-action-sidebar-thread-active
data-app-action-sidebar-thread-id
```

and uses a `/thread/:conversationId` route. The complete UUID from an active semantic row is the primary binding source; the complete route UUID is a fallback.

Every navigation must satisfy:

```text
renderer-selected-thread-id == collector-known-root-thread-id
```

If the renderer does not expose a valid UUID, or the collector does not know it, the meter must:

- Show `SESSION UNKNOWN`.
- Hide or freeze numerical metrics.
- Never substitute the newest rollout file.
- Never carry values from the previously selected session.

This probe is version-sensitive and is a release gate for each supported Codex build.

## 6. Real-time motion

Codex records token usage after a model completion rather than once per streamed token ([usage recording](https://github.com/openai/codex/blob/30d99232f485bd64eda9f6e0d9433bceebb2cb2b/codex-rs/core/src/session/turn.rs#L2485-L2542)). Expected behavior is therefore stepwise:

- Agentic tool loops can produce several jumps in one turn.
- A long single completion can remain unchanged until it finishes.
- The counter rolls from the previous confirmed value to the new confirmed value.
- The mechanical needle overshoots slightly and settles at the new trailing rate.
- No numerical token value increases speculatively.

## 7. Anomaly detection

A global arithmetic average is too sensitive to outliers and ignores model, reasoning effort, tools, and subagents. The MVP uses completed historical turns to derive a median, median absolute deviation, mean, and high percentile. It requires a minimum observation time and token count before alerting.

The initial warning threshold is the greater of:

```text
2.5 * historical median rate
historical median rate + 3 * robust noise floor
```

The warning copy avoids asserting an OpenAI bug. It states that high usage may indicate a large or polluted context, retry/tool loop, or expensive background work and suggests stopping or continuing in a new session.

## 8. Security and privacy

Loopback CDP is still a privileged debugging interface. Dream Skin explicitly warns users not to run untrusted local software while it is enabled ([runtime security notes](https://github.com/Fei-Away/Codex-Dream-Skin/blob/0a727a539fc9cd298ad4827c6cefbd4a2192db79/macos/references/runtime-notes.md#L7-L15)).

Required controls:

- Bind CDP only to `127.0.0.1`.
- Verify the listener belongs to the expected Codex application process.
- Accept only validated `app://` main-renderer targets.
- Reject avatar, pet, and auxiliary surfaces.
- Never log page titles, prompts, messages, reasoning, or tool output.
- Never modify or re-sign the official app bundle.
- Remove injected DOM on shutdown.
- Restart Codex normally to close the debugging port after disabling the meter.

## 9. Claude Code follow-on

Claude Code has a documented native `statusLine`, but it is a terminal status line rather than a lower-right graphical widget. It runs a local command, receives session JSON on stdin, and can refresh once per second ([status line](https://code.claude.com/docs/en/statusline)).

The stronger exact usage source is `claude_code.api_request` OpenTelemetry. Events include `session.id`, `prompt.id`, timestamp, input, output, cache-read, and cache-creation tokens. API calls caused by one user prompt share a prompt ID, which supports exact session, hour, and prompt aggregation ([monitoring](https://code.claude.com/docs/en/monitoring-usage)).

Recommended Claude architecture:

```text
Claude Code OTel events
        |
        v
Local collector and historical baseline
        |
        +--> native statusLine
        |
        +--> Stop hook warning
```

A Claude plugin cannot currently install the main `statusLine` through its default settings alone, so setup requires an explicit user-approved settings step ([plugins](https://code.claude.com/docs/en/plugins), [plugin reference](https://code.claude.com/docs/en/plugins-reference)). Transcript parsing should remain a versioned fallback.

## 10. Recommendation

Proceed in this order:

1. Read and aggregate rollout token events without retaining content.
2. Bind the exact selected desktop thread UUID.
3. Fail closed when binding is unavailable.
4. Inject the shadow-DOM meter and confirmed-sample animation.
5. Validate navigation, multiple windows, background agents, and resumed sessions.
6. Add historical alerts.
7. Package a safe macOS controller with explicit restart and restore flows.
8. Add Claude Code using OTel plus its native status line.

The concept is viable. The telemetry is sufficiently rich. The main product risk is presenting version-sensitive desktop injection as if it were a stable official Codex UI contribution point.

