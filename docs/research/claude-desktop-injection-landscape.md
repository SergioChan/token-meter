# Claude Desktop UI Injection Landscape

Surveyed on 2026-08-05. This note distinguishes modifications of the official
Claude Desktop application from products that only look similar because they
wrap Claude Code, render a terminal status line, or place a separate native
window above Claude.

## Conclusion

No public project found in this survey demonstrates persistent arbitrary DOM or
CSS injection into the **current, stock, Anthropic-signed macOS Claude Desktop**
without at least one of the following:

1. an Anthropic-issued `CLAUDE_CDP_AUTH` value;
2. copying or modifying `app.asar` or Electron fuse state and re-signing the
   resulting application; or
3. drawing a separate native overlay window that is not part of Claude's DOM.

This is a statement about the public implementations inspected, not a proof
that no undisclosed route can exist. It also differs by platform: real Claude
Desktop themes exist for patched Windows builds and unofficial Linux
repackages, but neither is a clean injection route into the stock macOS app.

The blocker observed by Token Meter is independently reflected in other source:

- [ClaudeDesktopPlusPlus's application analysis](https://github.com/2270525352/ClaudeDesktopPlusPlus/blob/main/docs/claude-desktop-1.15962.1-analysis.md)
  says the app exits when a remote-debugging flag lacks a valid, signed
  `CLAUDE_CDP_AUTH`, and identifies a controlled preload/`app.asar` patch as the
  practical alternative. Its [launcher](https://github.com/2270525352/ClaudeDesktopPlusPlus/blob/main/crates/claude-plus-launcher/src/main.rs)
  reports this gate when CDP never becomes available; its patch command only
  stages a modified archive through
  [`asar_patch.rs`](https://github.com/2270525352/ClaudeDesktopPlusPlus/blob/main/crates/claude-plus-core/src/asar_patch.rs).
- [SLICC marks Claude as a CDP-blocked application](https://github.com/ai-ecoverse/slicc/blob/main/packages/swift-launcher/Sliccstart/Models/AppScanner.swift).
  Its opt-in workaround is explicitly a *debug build*: it copies the app, flips
  Electron fuses, patches the JavaScript authorization guard, and ad-hoc signs
  the copy in
  [`DebugBuildCreator.swift`](https://github.com/ai-ecoverse/slicc/blob/main/packages/swift-launcher/Sliccstart/Models/DebugBuildCreator.swift).
- The official Linux package has the same class of hardening. The
  [`claude-desktop-debian` test-harness notes](https://github.com/aaddrick/claude-desktop-debian/blob/main/tools/test-harness/README.md#l1-attach-is-fused-off-on-the-official-build-post-v300)
  record that the shipped Electron has Node inspector and `RunAsNode` paths
  fused off and that its renderer-level tests cannot attach to the stock build.

## Project classification

| Project | Correct category | What it actually does | Evidence relevant to stock macOS Claude |
| --- | --- | --- | --- |
| [ClaudeDesktopPlusPlus](https://github.com/2270525352/ClaudeDesktopPlusPlus) | Companion launcher plus dormant/staged injection work | Manages providers, plugins, localization, and launching. Its external CDP route detects the signed-auth failure; its deeper route builds a staged patched `app.asar`. | It does not demonstrate arbitrary injection into an unmodified current macOS app. Its own analysis says patching is the practical route. |
| [Claude Buddy](https://github.com/Uplift-Foundation/Claude-Buddy) | External native companion/overlay | Uses Claude Code hooks and transcript files to show one orb per CLI session. Its Claude Desktop profile tint is a click-through borderless window positioned over Claude. | Its README explicitly explains that the tint is an overlay because remote CSS injection is gated. [`ClaudeDesktopOverlay.cs`](https://github.com/Uplift-Foundation/Claude-Buddy/blob/main/ClaudeDesktopOverlay.cs) never becomes part of Claude's DOM. |
| [claude-theme-mod](https://github.com/sillyhappydog/claude-theme-mod) | Patched Windows skin | Flips Electron fuses, extracts and changes `app.asar`, patches the argv guard, and injects CSS through `webContents.insertCSS()`. | This is genuine theming, but only after binary/archive modification. The README notes that fuse flipping invalidates the signature and updates reset the patch. It is not a macOS no-patch route. |
| [claude-desktop-extra](https://github.com/patrickjaja/claude-desktop-extra) | Unofficial patched Linux repackage | Applies a build-time theme patch; [`add_feature_custom_themes.nim`](https://github.com/patrickjaja/claude-desktop-extra/blob/main/patches/add_feature_custom_themes.nim) installs CSS through Electron APIs. | This proves that a modified/repackaged Claude build can be themed. It does not modify the stock signed macOS application at runtime. |
| [SLICC](https://github.com/ai-ecoverse/slicc) | Generic Electron CDP injector with a patched-copy fallback | Its normal Electron mode relaunches a target with remote debugging and injects an iframe overlay. Claude is explicitly rejected by that normal route; the fallback creates and re-signs a patched debug copy. | Useful implementation reference only if modifying/re-signing a copy is acceptable. |
| [Claude HUD](https://github.com/jarrodwatts/claude-hud) | Claude Code plugin / terminal status line | Uses Claude Code's native status-line input plus transcript JSONL to render context, tools, agents, and usage in the terminal. | It does not inject into Claude Desktop. This is the most common false equivalence in search results. |
| [Claude Code UI](https://github.com/siteboon/claudecodeui) and [Opcode](https://github.com/winfunc/opcode) | Alternative GUI clients/wrappers | Provide their own web or desktop interface around Claude Code sessions. | Their UI is controllable because it belongs to those projects; they do not add elements to the official Claude Desktop renderer. |

Other theme/localization projects follow the same modification pattern. For
example, [Claude UI Customization App](https://github.com/Meritas-V/Claude-UI-Customization-App)
backs up and rewrites `app.asar`, while
[claude-desktop_win-zh_cn](https://github.com/Jyy1529/claude-desktop_win-zh_cn)
patches installed Windows resources and frontend chunks.

## Why a native overlay cannot yet bind to the selected Code session exactly

A native overlay can safely discover that a Claude window is foreground and
obtain its owner PID and frame. Claude Buddy documents this exact macOS design:
its tint follows the foreground Claude instance using
`CGWindowListCopyWindowInfo`, then draws a click-through window over that
frame. That OS-level information identifies a **window/profile**, not the
Code-tab session selected inside the renderer.

The distinction matters because Claude Desktop can run several sessions in
parallel; Anthropic's [Desktop documentation](https://code.claude.com/docs/en/desktop)
says each sidebar conversation is an independent session and that several can
run concurrently. An external collector can enumerate local session metadata,
transcripts, child processes, and activity timestamps, but none of those is a
transactional statement that the user has selected a particular
`local_<uuid>` in the sidebar. Choosing the newest process, newest transcript,
or latest focus timestamp is only a heuristic and can switch the meter to a
background session that is still working.

An exact, fail-closed overlay therefore still needs one verified signal from
the host UI, such as:

- a stable Accessibility node whose value contains the selected session's
  unique identifier;
- a stable route/URL carrying `local_<uuid>`; or
- a supported host IPC or extension event that publishes the selected session.

Window APIs alone expose none of those. Accessibility may expose a selected
sidebar *label*, but titles and project names can collide and no stable AX
attribute containing `local_<uuid>` has yet been verified. Until such a signal
is demonstrated live, a native overlay can show aggregate activity or ask the
user to bind a session manually, but it cannot honestly claim atomic meter
switching with the current Code-tab selection.

## Recommended simultaneous-host behavior

Today the behavior is unambiguous: Codex Desktop can show its injected meter,
while stock Claude Desktop shows no meter because its UI adapter is blocked.

If Token Meter adds a separate macOS companion overlay, it should keep metrics
keyed by `(host, window, session)` rather than maintain one global accumulator.
The safe default should be one overlay attached visually to the foreground
eligible window:

- when a Codex window is foreground, render that window's selected Codex
  session;
- when a Claude window is foreground, render its selected Claude session only
  after the resolver returns an exact identity;
- when the Claude resolver is unbound, hide the values or show an explicit
  unbound state instead of retaining the preceding Codex or Claude numbers; and
- switch the entire snapshot atomically on focus or session changes, so totals,
  rate, needle, and alert state can never come from different sessions.

A native companion could create one overlay per visible host window in theory,
but that should not be the default until cross-process window ordering is
proven. A topmost overlay does not inherit a foreign application's window
stacking: an overlay left above a background host can cover an unrelated
foreground window. Claude Buddy encountered this exact failure and deliberately
limits its Desktop tint to the frontmost Claude instance. Renderer injection,
when supported by a host, does not have that problem because the meter belongs
to the host window's own DOM.

## Official extension surfaces

Anthropic does provide extension mechanisms, but none is documented as an
arbitrary host-renderer injection API:

- [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference)
  package skills, agents, hooks, MCP/LSP servers, monitors, and experimental
  Claude Code color themes. The documented themes are JSON color-token presets
  selected through `/theme`, not arbitrary CSS, DOM scripts, or fixed widgets.
  The [Desktop reference](https://code.claude.com/docs/en/desktop#install-plugins)
  documents Desktop plugins as skills, agents, hooks, MCP servers, and LSP
  configurations; it does not document a host-shell widget API.
- [Claude Code status lines](https://code.claude.com/docs/en/statusline) receive
  session JSON on stdin and print terminal text. This is the supported surface
  used by Claude HUD, but the Desktop Code tab does not expose it as a permanent
  lower-right graphical panel.
- [MCP Bundles](https://github.com/modelcontextprotocol/mcpb) package local MCP
  servers for one-click installation. They extend available tools; they do not
  receive authority to mutate Claude Desktop's renderer.

For Token Meter, the honest current options are therefore: wait for a supported
host UI/selection API, accept a patched and re-signed Claude copy with its
maintenance and security costs, or ship a native overlay with a manual or
otherwise explicitly verified session-binding mechanism.
