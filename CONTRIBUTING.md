# Contributing to Token Meter

Thank you for helping make agent token usage easier to understand.

## Before you start

- Search existing issues before opening a new one.
- Use a focused issue for behavior changes or compatibility work.
- Do not include prompts, transcripts, reasoning, tool output, account details, or private rollout data in issues, fixtures, screenshots, or logs.
- For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of filing a public issue.

## Development setup

Token Meter requires Node.js 22.12 or newer and has no third-party runtime dependencies.

```bash
git clone https://github.com/SergioChan/token-meter.git
cd token-meter
npm test
npm run check
```

## Engineering invariants

Changes must preserve these properties:

- An unknown selected task fails closed and never falls back to the newest Session.
- Token numbers advance only from confirmed host telemetry.
- Cached input is never added on top of total input.
- Child-Agent usage remains visible and explicitly labeled.
- Renderer scripts are registered only after the target passes semantic verification.
- CDP remains loopback-only and is accepted only from the verified official Codex process tree.
- The collector never retains prompt, reasoning, tool, or assistant content.
- Shutdown removes injected DOM and never force-quits Codex.

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
5. Control-C removes the overlay.

## Pull requests

- Keep each pull request focused on one outcome.
- Explain the user-visible behavior and security implications.
- Include test evidence and the Codex version used for live validation.
- Update README, architecture, compatibility notes, and screenshots when public behavior changes.
- Use concise imperative commit messages, for example `fix: reject an unverified renderer`.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
