# Security Policy

Token Meter uses two local Desktop integration mechanisms: Codex opens a loopback Chromium DevTools Protocol endpoint and receives a renderer payload; Claude uses an independent native companion with macOS Accessibility permission. Treat changes to launch, process verification, target selection, Accessibility parsing, event parsing, and cleanup as security-sensitive.

## Supported versions

Security fixes are applied to the latest commit on `main`. No older release line is currently maintained.

## Report a vulnerability

Do not open a public issue for a vulnerability or include private Codex data in a report.

Use [GitHub private vulnerability reporting](https://github.com/SergioChan/token-meter/security/advisories/new). Include:

- The affected commit and host application version.
- Reproduction steps using synthetic or redacted data.
- The expected and observed security boundary.
- Whether the issue can expose renderer or Accessibility contents, attach to the wrong process or Session, escape loopback, persist after shutdown, or modify an official application bundle.

You should receive an initial response within seven days. Please allow a reasonable remediation window before public disclosure.

## Threat model

### Codex Desktop

The Codex integration is designed to defend against accidental renderer confusion and untrusted local listeners. It:

- Binds CDP to `127.0.0.1` only.
- Verifies the exact official application path, bundle ID, signature, and OpenAI Team ID.
- Performs that verification in the system shell before executing the Node runtime inside the application bundle, then verifies it again at the injector boundary.
- Verifies one listening socket and its Codex process tree.
- Accepts loopback WebSocket targets only.
- Probes semantic main-renderer markers before registering the payload.
- Rejects Avatar, blank, and auxiliary surfaces.
- Reads rollout files without retaining content-bearing events.
- Installs only a per-user LaunchAgent and a copied runtime under the current user's Application Support directory.
- Makes at most one normal quit/relaunch attempt for a Codex process that lacks the required endpoint; it never force-quits or enters a relaunch loop.

Token Meter cannot protect the CDP endpoint or its user-writable installed copy from a malicious process already running as the same macOS user. Do not run untrusted local software while CDP is enabled. Uninstall with `./scripts/uninstall-token-meter-macos.sh --restart`, or restart Codex normally after stopping a one-shot run, to close the endpoint.

### Claude Code in Claude Desktop

The Claude integration is designed to defend against accidental Session confusion and excessive Accessibility collection. It:

- Verifies the canonical Claude.app path, bundle ID, signature, Anthropic Team ID, executable, and packaged model catalog before installation.
- Builds a separate background application with its own bundle ID; it does not patch, inject into, replace, or re-sign Claude.app.
- Requires Accessibility permission for `Token Widget for Claude.app` itself.
- Requires exactly one eligible `AXWebArea` in the frontmost Claude focused window; links, extra route components, and multiple candidates fail closed.
- Reads Accessibility roles and the exact WebArea URL for identity, then only button titles inside that same web area for an optional strict Context-window ratio. It does not read static text, values, descriptions, or message bodies.
- Hides when Claude is not frontmost or when exact Session identity is missing or ambiguous.
- Resolves one exact Desktop Session to one local Claude Code transcript identity and never falls back to file recency or display name.
- Discards prompt, reasoning, tool, and assistant content while retaining identifiers, event types, timestamps, and numerical usage required for aggregation.
- Validates structured health state against the exact installed executable and an argument boundary, then checks Accessibility live and reports UI, bridge, and Session readiness separately; prefix lookalikes are rejected.
- Never quits or relaunches Claude.

Accessibility permission allows the companion to inspect UI elements exposed by applications in the user's session. Token Meter intentionally narrows its reads, but a maliciously modified installed companion could abuse that permission. Install only from a reviewed source revision and keep the installed directory writable only by the current user.

Source builds are ad-hoc signed by default. Their code identity can change after rebuilding, which may require renewed Accessibility approval. They also record the selected external Node.js path; if that runtime is later removed, rerun the installer with a compatible runtime.

Deleting the application does not automatically delete its macOS TCC decision. Revoke **Token Widget for Claude** in System Settings, or uninstall with `./scripts/uninstall-claude-meter-macos.sh --purge-state --reset-accessibility`.

### Community identity and browser sessions

The optional community registry uses a local Ed25519 identity rather than a password account. The private key is stored only in the user's Application Support identity file with user-only permissions. The registry accepts handle claims, usage reports, and browser-pairing requests only when their signatures match the Meter ID derived from the submitted public key.

Usage sharing is disabled by default and remains independent of browser pairing. Reports contain aggregate daily totals and headline statistics only. They do not contain prompts, responses, tool calls, transcript paths, Session IDs, or private keys.

Browser pairing has these boundaries:

- Pairing codes contain 192 bits of randomness, expire after five minutes, and may be exchanged once.
- Pairing and browser-session secrets are stored server-side only as SHA-256 hashes.
- The pairing code is placed in the URL fragment and removed before the page contacts the registry, so it is not sent in the initial HTTP request or retained in normal navigation history.
- Browser sessions use 256-bit random tokens in `__Host-` cookies with `Secure`, `HttpOnly`, `SameSite=Lax`, and no `Domain` attribute. Sessions expire after 30 days and may be explicitly revoked from the Leaderboard.
- Browser session responses expose an opaque, truncated hash for row matching; the public Leaderboard does not expose full Meter IDs.
- Session exchange and revocation reject untrusted browser origins. Loopback HTTP is accepted only for local development.

Possession of an unexpired, unused pairing URL is sufficient to connect a browser to that Meter. Treat it as a short-lived secret and do not post or forward it. A malicious process running as the same macOS user could read the local private key or control the browser; Token Widget does not claim to defend against a fully compromised user account.
