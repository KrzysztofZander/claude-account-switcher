# Changelog

## 0.2.2

- Added independent account windows, Say Hi warmups, and safer cross-window token-refresh locking.
- Added isolated profile reauthorization for broken accounts. The fallback login runs in that
  profile's own `CLAUDE_CONFIG_DIR`, so another active account cannot overwrite it.
- Added account identity checks through `claude auth status --json`; reauthorization is rejected if
  the completed login belongs to a different known profile.
- Hardened credential handling so empty or incomplete OAuth credentials are ignored and never
  written to Claude Code.
- Updated Claude OAuth refresh requests with the current beta header, default Claude Code scopes,
  and clearer local validation before hitting the token endpoint.
- Show the panel's `Auth` action only for profiles that actually need reauthorization.
- Improved CLI discovery, Windows command quoting, and troubleshooting for login and warmup flows.

## 0.2.1

- Fixed token refresh to use the current Claude Code OAuth token endpoint and include saved scopes
  in the refresh request.

## 0.2.0

- Added independent account windows. Each account can now open the current project in a separate
  VS Code window with its own isolated `CLAUDE_CONFIG_DIR` and `.credentials.json`.
- Added "Say Hi" warmups for inactive saved accounts using `claude -p "Hi"` with `haiku` by default,
  without switching the active account.
- Added a login helper command that opens `claude auth login` in an integrated terminal.
- Documented that Claude Code CLI is required for correct operation.
- Documented the privacy and security model: no telemetry, no data collection, no custom backend,
  and credentials are used only locally or with Anthropic/Claude Code endpoints required for the
  selected feature.
- Added Claude Code CLI auto-detection and clearer Say Hi troubleshooting when `claude` is not in
  the VS Code extension host PATH.
- Fixed Windows Say Hi launcher quoting for full `claude.exe` paths.
- Made the active account marker workspace-scoped, so separate VS Code windows can track different
  active accounts independently.
- Added cross-window locking around token refreshes to reduce intermittent login failures from
  rotating refresh tokens.
- Avoided overwriting saved profiles when an unknown account is detected in the credentials file.
- Added settings for the Claude CLI command, Say Hi model, Say Hi prompt, and Say Hi timeout.

## 0.1.0

- Initial release.
- Save the currently logged-in Claude account as a profile (tokens stored in SecretStorage).
- Fast account switching (panel, status bar, QuickPick) by swapping `~/.claude/.credentials.json`,
  with a `.bak` backup and an undo command.
- Live usage limits (5-hour and weekly windows) from the `/api/oauth/usage` endpoint,
  with auto-refresh, backoff on 429, and manual refresh.
- Automatic refresh of expired tokens (refresh token flow).
