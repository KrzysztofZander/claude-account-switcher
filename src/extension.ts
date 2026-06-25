import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { CredentialsManager } from "./credentials";
import { TokenRefresher } from "./oauth";
import { SwitchService } from "./switchService";
import { AccountsViewProvider } from "./ui/accountsView";
import { StatusBarController } from "./ui/statusBar";
import { UsagePoller } from "./usage";
import { AccountProfile } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  const store = new AccountStore(context);
  const credentials = new CredentialsManager();
  const refresher = new TokenRefresher();
  const switchService = new SwitchService(store, credentials);
  const statusBar = new StatusBarController(store);
  const viewProvider = new AccountsViewProvider(context.extensionUri, store);

  const getInterval = () =>
    vscode.workspace.getConfiguration("claudeSwitcher").get<number>("pollIntervalSeconds", 240);

  const refreshUI = () => {
    statusBar.refresh();
    viewProvider.refresh();
  };

  const poller = new UsagePoller(store, refresher, credentials, getInterval, refreshUI);

  // On startup: sync the active account from the file and render the state.
  void store.syncActiveFromFile(credentials.readCurrent()).then(refreshUI);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AccountsViewProvider.viewType, viewProvider),
    statusBar,
    { dispose: () => poller.stop() }
  );

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.addCurrentAccount", async () => {
      const res = await switchService.captureCurrent();
      vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      if (res.ok) {
        const activeId = store.getActiveId();
        if (activeId) {
          await poller.pollOne(activeId, true);
        }
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.switchAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Switch to account…"));
      if (!targetId) {
        return;
      }
      const res = await switchService.switchTo(targetId);
      if (!res.ok) {
        vscode.window.showWarningMessage(res.message);
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.refreshUsage", async (id?: string) => {
      if (id) {
        await poller.pollOne(id, true);
        refreshUI();
      } else {
        await poller.pollAll(true);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.removeAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Remove account profile…"));
      if (!targetId) {
        return;
      }
      const profile = store.get(targetId);
      const confirm = await vscode.window.showWarningMessage(
        `Remove the profile "${profile?.label ?? targetId}"? (does not log the account out of Claude)`,
        { modal: true },
        "Remove"
      );
      if (confirm === "Remove") {
        await store.remove(targetId);
        refreshUI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.renameAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Rename profile…"));
      if (!targetId) {
        return;
      }
      const profile = store.get(targetId);
      const label = await vscode.window.showInputBox({
        title: "New profile name",
        value: profile?.label,
        validateInput: (v) => (v.trim().length === 0 ? "Enter a name" : undefined),
      });
      if (label) {
        await store.rename(targetId, label.trim());
        refreshUI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.undoSwitch", async () => {
      const res = await switchService.undoSwitch();
      vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.openPanel", () => {
      void vscode.commands.executeCommand("claudeSwitcher.accountsView.focus");
    })
  );

  // React to interval setting changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeSwitcher.pollIntervalSeconds")) {
        poller.restart();
      }
      if (e.affectsConfiguration("claudeSwitcher.warnThresholdPercent")) {
        refreshUI();
      }
    })
  );

  poller.start();
}

export function deactivate(): void {
  /* resources are released via context.subscriptions */
}

/** Compact countdown string ("2h15m", "45m", "3d4h") for a resets_at ISO timestamp. */
export function fmtResetCompact(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return undefined;
  const diff = t - Date.now();
  if (diff <= 0) return "now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return `${hours}h${rem}m`;
  const days = Math.floor(hours / 24);
  return `${days}d${hours % 24}h`;
}

/** Builds the QuickPick items (label/description) for the account list — pure, for testability. */
export function buildAccountItems(
  accounts: AccountProfile[],
  activeId: string | undefined
): { label: string; description: string; id: string }[] {
  return accounts.map((p: AccountProfile) => {
    const u = p.lastUsage;
    const session = u?.windows.find((w) => w.kind === "session");
    const weekly = u?.windows.find((w) => w.kind === "weekly_all" || w.kind.startsWith("weekly"));
    const parts: string[] = [];
    if (typeof u?.sessionPercent === "number") {
      const reset = fmtResetCompact(session?.resetsAt);
      parts.push(`5h: ${u.sessionPercent}%` + (reset ? ` - ${reset}` : ""));
    }
    if (typeof u?.weeklyPercent === "number") {
      const reset = fmtResetCompact(weekly?.resetsAt);
      parts.push(`weekly: ${u.weeklyPercent}%` + (reset ? ` - ${reset}` : ""));
    }
    if (u?.error) parts.push("⚠ usage error");
    return {
      label: (p.id === activeId ? "$(check) " : "$(account) ") + p.label,
      description: [p.subscriptionType, parts.join(" | ")].filter(Boolean).join("  ·  "),
      id: p.id,
    };
  });
}

/** Shared account-picker QuickPick with a usage preview. */
async function pickAccount(store: AccountStore, title: string): Promise<string | undefined> {
  const activeId = store.getActiveId();
  const accounts = store.list();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No saved accounts. Use \"Save current account as profile\" first."
    );
    return undefined;
  }

  const items = buildAccountItems(accounts, activeId);

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Select an account",
    matchOnDescription: true,
  });
  return picked?.id;
}
