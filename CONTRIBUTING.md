# Contributing to Token Meter

Thank you for helping make agent token usage easier to understand.

## Before you start

- Search existing issues before opening a new one.
- Use a focused issue for behavior changes or compatibility work.
- Do not include prompts, transcripts, reasoning, tool output, account details, or private rollout data in issues, fixtures, screenshots, or logs.
- For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of filing a public issue.

## Development setup

Token Meter development requires Git and Node.js 22.12 or newer. Building the native Claude companion also requires macOS 13 or newer and Xcode Command Line Tools with Swift.

```bash
git clone https://github.com/SergioChan/token-meter.git
cd token-meter
npm test
npm run check
./scripts/doctor-claude-meter-macos.sh
```

## Engineering invariants

Changes must preserve these properties:

- An unknown selected task fails closed and never falls back to the newest Session.
- Token numbers advance only from confirmed host telemetry.
- Active Context follows the selected root thread and is never summed across independent child-Agent context windows.
- Compaction may reduce Active Context but must never reduce cumulative Session usage.
- Cached input is never added on top of total input.
- Raw rollout totals must never be labeled as Codex `/usage`, backend billing, credits, or exact per-Session account consumption.
- Child-Agent usage remains visible and explicitly labeled.
- Renderer scripts are registered only after the target passes semantic verification.
- Codex CDP remains loopback-only and is accepted only from the verified official Codex process tree.
- Claude binds only the exact local Session exposed by the focused Accessibility window and never falls back to recency or display name.
- The Claude companion remains independent from Claude.app, waits quietly when permission is absent, and never quits or relaunches Claude.
- The collector never retains prompt, reasoning, tool, or assistant content.
- Shutdown removes injected DOM or the native companion panel and never force-quits a host.

## Tests

Behavior changes require a regression test at the public seam where the behavior is observed.

```bash
npm test
npm run check
```

For Codex compatibility changes, also verify:

1. The active Session binds by exact UUID.
2. Switching tasks switches the complete Meter.
3. Avatar, blank, and auxiliary renderers remain untouched.
4. A confirmed token event moves the number or delta pulse and the needle.
5. A compaction fixture reduces Active Context without reducing cumulative Session usage.
6. The LaunchAgent loads at login and makes no more than one normal recovery attempt per Codex process.
7. Control-C removes a one-shot overlay, and uninstall removes the persistent service.

For Claude compatibility changes, also verify:

1. The focused Code Session binds by exact `local_<uuid>`.
2. Switching Sessions replaces the complete snapshot without retaining previous values.
3. Chat, Cowork, Settings, auxiliary windows, and non-frontmost Claude hide the panel.
4. Expanded and collapsed layouts both drag and persist correctly.
5. Active Context uses root input-side usage and an exact model-window source.
6. Missing Accessibility permission produces no repeated prompt, process churn, or Claude restart.
7. Install, status, update, and uninstall leave the official Claude.app untouched.
8. Installation rejects unsafe managed paths and restores the previous companion if replacement readiness fails.

## Pull requests

- Keep each pull request focused on one outcome.
- Explain the user-visible behavior and security implications.
- Include test evidence and the Codex version used for live validation.
- Update README, architecture, compatibility notes, and screenshots when public behavior changes.
- Use concise imperative commit messages, for example `fix: reject an unverified renderer`.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
