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
- **Status bar** — the active account and its usage % always in view.

## How it works

- Claude Code credentials live in `~/.claude/.credentials.json`. Switching accounts simply and
  safely swaps the contents of that file (a `.bak` backup is kept so you can undo).
- **After switching you must reload the VS Code window** so Claude Code picks up the new
  account — the extension offers to do it automatically (auto-reload can be enabled in settings).
- Usage is read from the unofficial `api.anthropic.com/api/oauth/usage` endpoint (the same
  source as `/usage`). It is **heavily rate-limited**, so refreshing is capped to a safe interval
  (240s by default, minimum 180s) plus a manual ⟳ refresh.

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
| `Claude: Undo last switch` | restores the previous account from `.bak` |
| `Claude: Remove / Rename account profile` | manage profiles |

## Settings

| Key | Default | Description |
| --- | --- | --- |
| `claudeSwitcher.pollIntervalSeconds` | `240` | auto-refresh interval (min 180) |
| `claudeSwitcher.autoReloadAfterSwitch` | `false` | auto-reload the window after switching |
| `claudeSwitcher.credentialsPath` | `""` | override the path to `.credentials.json` |
| `claudeSwitcher.warnThresholdPercent` | `80` | warning threshold (% → red bar) |

## Security and disclaimers

- OAuth tokens are stored only in VS Code's **encrypted `SecretStorage`**; they are never logged
  or sent anywhere except the official Anthropic endpoints.
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
