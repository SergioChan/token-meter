# Token Widget automated installation task

You are the installation agent. Install and verify Token Widget from this repository on the user's macOS machine. Work autonomously through all safe, reversible steps, but obey every confirmation gate below.

## Objective

Install Token Widget for every supported Desktop host that is actually present:

- Codex Desktop for macOS: verified loopback CDP injection.
- Claude Code inside Claude Desktop for macOS: native companion overlay using exact Accessibility Session binding.

Finish only when each selected host is installed and its real runtime status has been verified, or when a clearly identified user-only permission step remains.

## Safety rules

1. Never modify, unpack, patch, replace, or re-sign Codex.app or Claude.app.
2. Never force-quit either host.
3. Never quit or restart Claude Desktop. The Claude integration does not require it.
4. Before any Codex quit or relaunch, inspect whether Codex is running and whether `http://127.0.0.1:9334/json/version` is already available. If Codex is running without that endpoint, explain that one normal relaunch is required and obtain the user's explicit approval before continuing.
5. Do not install or commit demo folders, recordings, generated videos, private screenshots, logs, transcripts, prompts, or other local artifacts.
6. Do not retain or print message content from Codex or Claude transcripts. Verification may inspect identifiers, timestamps, event types, and numerical usage only.
7. Treat macOS Accessibility approval as a user-controlled security decision. You may open the correct System Settings panel and explain the required toggle, but do not attempt to bypass TCC.

## Procedure

1. Resolve the repository root from this file. Confirm that it contains `package.json`, `runtime/`, `src/core/`, `integrations/codex-desktop/`, and `integrations/claude-desktop/`.
2. Read `README.md`, `docs/install-claude-desktop.md`, `integrations/codex-desktop/README.md`, and `integrations/claude-desktop/README.md` before installing.
3. Confirm the operating system is macOS and record the installed host paths:
   - Codex: `/Applications/ChatGPT.app`
   - Claude: `/Applications/Claude.app`
4. Run `./scripts/doctor-claude-meter-macos.sh` before a Claude installation. It checks Git, Node.js 22.12+, Xcode Command Line Tools, Swift, and code-signing tools. If a prerequisite is missing, ask before changing package-manager or Xcode state. Do not silently install or upgrade dependencies.
5. Run the repository verification suite:

   ```bash
   npm run ci
   ```

6. If Codex Desktop is installed:
   - Check the CDP endpoint first:

     ```bash
     curl --silent --fail --max-time 1 http://127.0.0.1:9334/json/version
     ```

   - If Codex is not running, or the endpoint is already healthy, run:

     ```bash
     ./scripts/install-token-meter-macos.sh
     ```

   - If Codex is running without the endpoint, stop and obtain explicit approval for the installer's one normal quit/relaunch recovery.
   - Verify the LaunchAgent and endpoint. Then inspect the verified renderer and confirm `window.__tokenMeter.version >= 6`, the collapse control is visible, and the card has draggable layout enabled.
7. If Claude Desktop is installed, run without quitting Claude:

   ```bash
   ./scripts/install-claude-meter-macos.sh
   ```

8. Check Claude companion status:

   ```bash
   ./scripts/status-claude-meter-macos.sh --json
   ```

   - If `accessibilityGranted` is `false`, open System Settings > Privacy & Security > Accessibility and ask the user to enable **Token Widget**.
   - After approval, wait up to 60 seconds, polling no faster than every five seconds, until `running`, `accessibilityGranted`, and `overlayReady` are all `true`.
   - Treat `bridgeHealthy` and `sessionBound` as foreground Session checks. They may correctly remain `false` while Claude is hidden or not showing Code.
   - Do not restart Claude while waiting.
9. Bring each installed host to the foreground only when needed for visual verification. Confirm:
   - The Meter follows the exact selected Session.
   - Switching Sessions switches all metrics atomically.
   - `−` collapses to the gauge and live rate; `+` expands it.
   - Expanded mode drags by the header; collapsed mode drags by the gauge.
   - Claude's active context shows both numerator and denominator when the local model catalog can resolve the current model.
10. Return a concise report containing:
    - Hosts detected and installed.
    - Exact installer and status commands used.
    - Test result counts.
    - Runtime verification evidence.
    - Any remaining user-only permission action.
    - Confirmation that Claude was not restarted and that no host application was modified.

Do not declare success from process presence alone. Verify the real overlay runtime and exact Session binding whenever the host and permission state allow it.
