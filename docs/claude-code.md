# Claude Code Adapter Status

## Current status

Claude Code is **not supported by the current repository**. The tree contains no Claude collector, plugin manifest, status-line command, settings installer, or Claude-specific tests.

The shared measurement model is suitable for a Claude adapter, but the host integration is distinct from Codex Desktop.

## Official integration surfaces

### Status line

Claude Code can run a local `statusLine` command and pass Session JSON on stdin. The input includes `session_id`, model, workspace, cost, rate-limit, and context-window fields. It supports color and a refresh interval as low as one second.

The context token fields are not a cumulative Session ledger. Current Claude Code documentation states that `context_window.total_input_tokens` and `total_output_tokens` describe the most recent API response; before Claude Code 2.1.132 they were cumulative. Token Meter therefore cannot derive a reliable Session total from the status-line payload alone.

Source: [Customize your status line](https://code.claude.com/docs/en/statusline).

### OpenTelemetry

Claude Code exports token metrics and request events through OpenTelemetry. Standard attributes include `session.id`; events also include `prompt.id`. Request telemetry includes input, output, cache-read, and cache-creation token counts.

This is the preferred source for Session, prompt, rolling-hour, and rate aggregation.

Source: [Monitoring usage](https://code.claude.com/docs/en/monitoring-usage).

### Plugin packaging

Claude Code plugins can package skills, hooks, executables, monitors, and MCP servers. Plugin default `settings.json` currently supports `agent` and `subagentStatusLine`. It does not support installing the main `statusLine` key, so enabling the primary Meter display requires an explicit user-approved settings step.

Sources: [Create plugins](https://code.claude.com/docs/en/plugins) and [Plugins reference](https://code.claude.com/docs/en/plugins-reference).

## Planned architecture

```text
Claude Code OpenTelemetry events
              |
              v
Local Session and prompt collector
              |
              v
Shared Token Meter snapshot model
              |
              +--> Native Claude Code statusLine
              +--> Advisory warning hook
```

## Acceptance criteria

Claude Code support should not be marked complete until the repository provides:

1. A versioned Claude plugin manifest and installer.
2. A local OpenTelemetry receiver or documented collector integration.
3. Exact `session.id` and `prompt.id` aggregation.
4. Session total, trailing hour, current prompt, and trailing rate metrics.
5. Native status-line rendering with green/yellow/orange/red intensity.
6. Explicit settings installation and complete uninstall instructions.
7. Synthetic fixtures and live Claude Code validation.
8. Privacy tests proving that prompt and response content are not retained.
