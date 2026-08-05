# Security Policy

Token Meter opens a loopback Chromium DevTools Protocol endpoint and injects a local renderer payload. Treat changes to launch, process verification, target selection, event parsing, and cleanup as security-sensitive.

## Supported versions

Security fixes are applied to the latest commit on `main`. No older release line is currently maintained.

## Report a vulnerability

Do not open a public issue for a vulnerability or include private Codex data in a report.

Use [GitHub private vulnerability reporting](https://github.com/SergioChan/token-meter/security/advisories/new). Include:

- The affected commit and Codex version.
- Reproduction steps using synthetic or redacted data.
- The expected and observed security boundary.
- Whether the issue can expose renderer contents, attach to a non-Codex process, escape loopback, persist after shutdown, or modify the official application bundle.

You should receive an initial response within seven days. Please allow a reasonable remediation window before public disclosure.

## Threat model

Token Meter is designed to defend against accidental target confusion and untrusted local listeners. It:

- Binds CDP to `127.0.0.1` only.
- Verifies the exact official application path, bundle ID, signature, and OpenAI Team ID.
- Performs that verification in the system shell before executing the Node runtime inside the application bundle, then verifies it again at the injector boundary.
- Verifies one listening socket and its Codex process tree.
- Accepts loopback WebSocket targets only.
- Probes semantic main-renderer markers before registering the payload.
- Rejects Avatar, blank, and auxiliary surfaces.
- Reads rollout files without retaining content-bearing events.

Token Meter cannot protect the CDP endpoint from a malicious process already running as the same macOS user. Do not run untrusted local software while CDP is enabled. Restart Codex normally after stopping Token Meter to close the endpoint.
