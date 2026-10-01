# Changelog

## 0.3.0

Fixes saved accounts and Claude Code itself repeatedly needing reauthorization.

- Token refreshes now take Claude Code's own refresh locks (`<configDir>/.oauth_refresh.lock`
  and the legacy `<configDir>.lock`) instead of a private lock in the temp directory, so Claude
  Code waits for the extension and adopts its rotation instead of spending the same single-use
  refresh token.
- Every rotation is written back (compare-and-swap) to all local credential files holding the
  login, and the newest generation across the vault, `~/.claude` and isolated config dirs is
  always used.
- Switching first saves the outgoing account's latest rotation under the lock. Previously a
  rotation made by Claude Code after the last poll was lost on switch, leaving the profile with a
  spent token.
- Undo restores the newest token generation of the previous profile instead of the raw `.bak`
  copy, which could contain an already rotated refresh token.
- Accounts are identified by Claude account id via `/api/oauth/profile` (no CLI needed), so a
  fully rotated login is still recognized. Team members sharing one organization and one person
  in several organizations are no longer confused with each other.
- Watches `.credentials.json` and imports Claude Code's rotations immediately.
- Switching also replaces `organizationUuid` in `.credentials.json` and `oauthAccount` in
  `.claude.json`, which previously kept the previous account's values.
- A refresh token rejected with `invalid_grant` is never sent again; the profile recovers on its
  own once any copy holds a newer login. Network errors no longer show "Needs reauthorization".
- New **+ Add account** flow logs in to another account in an isolated config dir without
  touching the current one; isolated logins and reauthorizations complete automatically.
  The panel's toolbar buttons are now "Save current" and "+ Add account".
- When Claude Code is logged in to an account that is not saved, the status bar shows it and the
  extension offers to save it.
- Browser authorization and default refresh scopes include `user:plugins`, matching current
  Claude Code.
- Documented that `/logout` revokes the login on Anthropic's side and must not be used to change
  accounts.

## 0.2.5

- Added browser-based OAuth authorization that works without Claude Code CLI.
- Automatically offer browser authorization when the CLI cannot be found.
- Added a dedicated command for browser authorization even when the CLI is available.

## 0.2.4

- Improved authorization reliability for saved accounts by consistently preserving and selecting
  the newest valid access and refresh token generation.
- Added cross-window active-profile leases so background usage polling never spends a rotating
  refresh token currently owned by Claude Code in another VS Code window.
- Propagate successful inactive-profile token rotations to matching credential files with an
  atomic compare-and-swap, preventing stale files from restoring already spent refresh tokens.
- Recover profiles previously marked `invalid_grant` when Claude Code has already persisted a
  newer valid token generation for the same saved profile.
- Reconcile fully rotated active credentials using the verified Claude account identity.

## 0.2.3

- Treat OAuth `invalid_grant` / invalid refresh-token responses as a reauthorization-needed
  state instead of a retryable usage-refresh failure.
- Stop automatic and manual usage refreshes from repeatedly retrying profiles that are already
  known to need reauthorization, reducing repeated "Failed to refresh token" noise.
- Clear stale usage errors and retry backoff automatically when a profile receives fresh
  credentials after reauthorization or a successful token update.
- Use the same per-account lock for Say Hi warmups and usage token refreshes, reducing refresh
  token races between background polling, warmups, and independent VS Code windows.
- Show a short "Needs reauthorization" message in the panel and status tooltip instead of the raw
  token endpoint error payload.

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
