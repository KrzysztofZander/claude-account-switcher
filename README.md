# Claude Multi-Account Switcher

Quickly switch between Claude accounts (subscriptions) in **Claude Code** inside VS Code,
with live usage limits for all your accounts at a glance.

## Why

You have several Claude subscriptions. When one account runs out of usage (the 5-hour or
weekly window), switch Claude Code to another account with a single click — no manual logout
and re-login.

## Features

- **Save accounts** — log in normally in Claude Code, then click "Save current account";
  the extension remembers the profile (tokens are kept in VS Code's encrypted secret storage).
- **Fast switching** — from the panel, the status bar, or the command palette (QuickPick).
- **Live usage limits** — utilization (%) of the 5-hour and weekly windows for each account,
  with time until reset. Data comes from the same source as the `/usage` command.
- **Say Hi warmup** — run a one-turn `claude -p "Hi"` on inactive saved accounts using
  `--model haiku` by default, without switching the active `.credentials.json`.
- **Independent account windows** — open the same project in separate VS Code windows, each
  with its own Claude account and `CLAUDE_CONFIG_DIR`.
- **Browser authorization** — if Claude Code CLI is unavailable, complete OAuth login in the
  default browser; a dedicated command is available even when the CLI is installed.
- **Login helper** — prefers an integrated terminal with `claude auth login` when the CLI is
  available, then falls back to browser authorization.
- **Isolated reauthorization** — if a saved profile's credentials break, re-login happens in
  that profile's own `CLAUDE_CONFIG_DIR` instead of copying the currently active account.
- **Status bar** — the active account and its usage % always in view.

## Requirements

- Claude Code CLI is optional for browser authorization, account switching, and usage checks.
  It is still required for **Say Hi**, CLI-based identity checks, and using Claude Code itself.
- For CLI-only features, the `claude` command must be available in VS Code's PATH, or
  `claudeSwitcher.claudeCommand` must point to the full path of `claude`, `claude.exe`, or
  `claude.cmd`.
- On Windows PowerShell, Claude Code CLI can be installed with:

```powershell
irm https://claude.ai/install.ps1 | iex
```

## How it works

- Claude Code credentials live in `~/.claude/.credentials.json`. Switching accounts simply and
  safely swaps the contents of that file (a `.bak` backup is kept so you can undo).
- **After switching you must reload the VS Code window** so Claude Code picks up the new
  account — the extension offers to do it automatically (auto-reload can be enabled in settings).
- Saved inactive accounts are warmed up through an isolated `CLAUDE_CONFIG_DIR` under the
  extension's global storage. This lets "Say Hi" refresh/use that account without changing the
  currently active Claude Code account.
- Independent windows use generated `.code-workspace` files under the extension's global storage.
  Each window points Claude Code at the selected account's isolated config directory.
- Usage is read from the unofficial `api.anthropic.com/api/oauth/usage` endpoint (the same
  source as `/usage`). It is **heavily rate-limited**, so refreshing is capped to a safe interval
  (240s by default, minimum 180s) plus a manual ⟳ refresh.
- Active profiles are advertised through short-lived cross-window leases. Background usage
  polling never spends a rotating refresh token owned by a live Claude Code window, while
  inactive-account refreshes remain guarded by a cross-window lock and are copied back to every
  matching local credential file.

## Usage

1. Log in to Claude Code with account #1.
2. Open the **Claude Accounts** panel (activity bar icon) → **"+ Save current account"**.
3. Log out / log in (`/login`) to account #2 in Claude Code → **"Save current account"** again.
4. From now on, switch with one click via **"Switch"** on an account card (or the status bar /
   `Claude: Switch account`). After confirmation the window reloads and Claude Code runs on the
   selected account.

## Commands

| Command | Description |
| --- | --- |
| `Claude: Save current account as profile` | saves the currently logged-in account |
| `Claude: Switch account` | QuickPick with usage limits |
| `Claude: Refresh usage limits` | forces a refresh |
| `Claude: Say Hi on account` | warms up inactive saved accounts via `claude -p` |
| `Claude: Open independent account window` | opens this project in a new VS Code window scoped to one account |
| `Claude: Log in from terminal` | opens `claude auth login`, or falls back to browser authorization when CLI is unavailable |
| `Claude: Authorize in browser (without CLI)` | completes OAuth authorization in the default browser |
| `Claude: Reauthorize account profile` | opens isolated login for a saved profile without touching the active account |
| `Claude: Complete profile reauthorization` | imports the completed isolated login into that same profile |
| `Claude: Undo last switch` | restores the previous account from `.bak` |
| `Claude: Remove / Rename account profile` | manage profiles |

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `claudeSwitcher.pollIntervalSeconds` | `240` | auto-refresh interval (min 180) |
| `claudeSwitcher.autoReloadAfterSwitch` | `false` | auto-reload the window after switching |
| `claudeSwitcher.credentialsPath` | `""` | override the path to `.credentials.json` |
| `claudeSwitcher.warnThresholdPercent` | `80` | warning threshold (% → red bar) |
| `claudeSwitcher.claudeCommand` | `claude` | CLI command used for CLI login and Say Hi; set the full path if VS Code cannot find it |
| `claudeSwitcher.sayHiModel` | `haiku` | model alias passed to `claude -p` |
| `claudeSwitcher.sayHiPrompt` | `Hi` | prompt used by Say Hi |
| `claudeSwitcher.sayHiTimeoutSeconds` | `120` | Say Hi timeout |

## Troubleshooting Say Hi

If Say Hi reports that `claude` is not recognized, the VS Code extension process cannot find the
Claude Code CLI. Try these in order:

1. Run `where claude` in PowerShell or CMD.
2. If it is found, restart VS Code so the extension host gets the refreshed PATH.
3. If it is not found, install Claude Code CLI. On Windows PowerShell, the official installer is:

```powershell
irm https://claude.ai/install.ps1 | iex
```

4. If the command exists but VS Code still cannot see it, set `claudeSwitcher.claudeCommand` to the
   full path, for example `C:\Users\you\AppData\Roaming\npm\claude.cmd` or the path returned by
   `where claude`.

## Parallel VS Code windows

Use **Claude: Open independent account window** or the **Window** button on an account card.
The extension writes the saved account credentials to a per-account config directory, generates a
`.code-workspace` file for the current folder/workspace, and opens it in a new VS Code window.

The default Claude Code login file is global, so two regular VS Code windows share the same active
account. Independent windows avoid that by setting both:

```json
{
  "claudeCode.environmentVariables": [
    {
      "name": "CLAUDE_CONFIG_DIR",
      "value": "C:\\Users\\you\\.claude-user2"
    }
  ],
  "claudeSwitcher.credentialsPath": "C:\\Users\\you\\.claude-user2\\.credentials.json"
}
```

Open one generated window per account you want to run. The extension refuses to open a second
active window for the same saved profile, because the upstream refresh token belongs to that
account and can rotate.

## Security and disclaimers

- This extension does **not** collect telemetry, analytics, account identifiers, prompts,
  credentials, tokens, usage data, or any other personal data.
- No login data is sent to the extension author, publisher, marketplace backend, or any custom
  third-party server controlled by this extension.
- Saved profile secrets are stored in VS Code's encrypted **SecretStorage**.
- Claude Code itself requires local `.credentials.json` files. For account switching, Say Hi,
  and independent windows, the extension writes credentials only to local Claude Code config
  directories on your machine, including isolated per-account `CLAUDE_CONFIG_DIR` folders under
  the extension's global storage.
- Credentials are never intentionally logged. Protect your machine and OS user account, because
  anyone with local filesystem access to your user profile may be able to read Claude Code
  credential files.
- Network requests made by the extension go only to Anthropic endpoints needed for token refresh
  and usage-limit checks. Say Hi is executed through the local Claude Code CLI, which communicates
  with Anthropic as Claude Code normally does.
- This tool is for managing **your own** accounts.
- The usage endpoint and the token-refresh flow are **unofficial** and may change or stop working
  on Anthropic's side.
- Currently the file-based `.credentials.json` model is supported (Windows/Linux). The macOS
  Keychain is not supported yet.

## Development

```bash
npm install
npm run watch       # build in watch mode
# press F5 in VS Code -> Extension Development Host
npm run build:vsix  # build the .vsix package
```

## License

MIT
