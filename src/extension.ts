import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { AccountWindowService } from "./accountWindow";
import { readClaudeAuthStatus } from "./authStatus";
import {
  getConfiguredClaudeCommand,
  missingClaudeCliMessage,
  quoteForTerminal,
  resolveClaudeCommand,
} from "./cli";
import { hasUsableOAuthCreds } from "./credentialValidation";
import { CredentialsManager } from "./credentials";
import { getAccountConfigDir } from "./isolatedConfig";
import { TokenRefresher } from "./oauth";
import { SwitchService } from "./switchService";
import { AccountsViewProvider } from "./ui/accountsView";
import { StatusBarController } from "./ui/statusBar";
import { UsagePoller } from "./usage";
import { AccountProfile, ClaudeAuthIdentity } from "./types";
import { WarmupService } from "./warmup";

export function activate(context: vscode.ExtensionContext): void {
  const store = new AccountStore(context);
  const credentials = new CredentialsManager();
  const refresher = new TokenRefresher();
  const switchService = new SwitchService(store, credentials);
  const warmupService = new WarmupService(context, store, credentials);
  const accountWindowService = new AccountWindowService(context, store, credentials);
  const statusBar = new StatusBarController(store);
  const viewProvider = new AccountsViewProvider(context.extensionUri, store);

  const getInterval = () =>
    vscode.workspace.getConfiguration("claudeSwitcher").get<number>("pollIntervalSeconds", 240);

  const refreshUI = () => {
    statusBar.refresh();
    viewProvider.refresh();
  };

  const openClaudeLogin = (options?: { configDir?: string; terminalName?: string }) => {
    const configuredCommand = getConfiguredClaudeCommand();
    const resolvedCommand = resolveClaudeCommand(configuredCommand);
    if (!resolvedCommand) {
      vscode.window.showWarningMessage(missingClaudeCliMessage());
    }

    const command = resolvedCommand ?? configuredCommand;
    const terminal = vscode.window.createTerminal({
      name: options?.terminalName ?? "Claude Login",
      env: options?.configDir ? { CLAUDE_CONFIG_DIR: options.configDir } : undefined,
    });
    terminal.show();
    terminal.sendText(`${quoteForTerminal(command)} auth login`);
  };

  const backfillKnownIdentities = async () => {
    for (const profile of store.list()) {
      if (profileHasIdentity(profile)) {
        continue;
      }
      const configDir = getAccountConfigDir(context, profile.id);
      if (!hasUsableOAuthCreds(credentials.readCurrent(configDir))) {
        continue;
      }
      const status = await readClaudeAuthStatus(configDir);
      if (status.ok && status.status?.loggedIn) {
        await store.updateIdentity(profile.id, status.status);
      }
    }

    const activeId = store.getActiveId();
    const activeProfile = activeId ? store.get(activeId) : undefined;
    if (activeId && activeProfile && !profileHasIdentity(activeProfile)) {
      const status = await readClaudeAuthStatus();
      if (status.ok && status.status?.loggedIn) {
        await store.updateIdentity(activeId, status.status);
      }
    }
  };

  const completeProfileReauthorization = async (
    id: string,
    silentWhenMissing = false
  ): Promise<{ ok: boolean; message: string; missing?: boolean }> => {
    const profile = store.get(id);
    if (!profile) {
      return { ok: false, message: "Profile not found." };
    }

    const configDir = getAccountConfigDir(context, id);
    const creds = credentials.readCurrent(configDir);
    if (!creds || !hasUsableOAuthCreds(creds)) {
      return {
        ok: false,
        missing: silentWhenMissing,
        message: `No completed isolated login found for "${profile.label}" yet.`,
      };
    }

    const status = await readClaudeAuthStatus(configDir);
    if (!status.ok || !status.status?.loggedIn) {
      return {
        ok: false,
        message:
          `Could not verify the isolated login for "${profile.label}": ` +
          (status.error ?? "Claude auth status did not report a logged-in account."),
      };
    }

    await backfillKnownIdentities();
    const latestProfile = store.get(id) ?? profile;
    const conflict = store.findByIdentity(status.status, id);
    if (conflict) {
      return {
        ok: false,
        message:
          `The isolated login belongs to "${conflict.label}" (${identityLabel(status.status)}). ` +
          `"${profile.label}" was not overwritten.`,
      };
    }

    const previousIdentity = profileIdentity(latestProfile);
    if (previousIdentity && !sameIdentity(previousIdentity, status.status)) {
      return {
        ok: false,
        message:
          `The isolated login identity (${identityLabel(status.status)}) does not match ` +
          `"${profile.label}" (${identityLabel(previousIdentity)}). The profile was not overwritten.`,
      };
    }

    await store.updateCreds(id, creds);
    await store.updateIdentity(id, status.status);
    return {
      ok: true,
      message: `Reauthorized "${profile.label}" as ${identityLabel(status.status)}.`,
    };
  };

  const startProfileReauthorization = async (id: string) => {
    const profile = store.get(id);
    if (!profile) {
      vscode.window.showWarningMessage("Profile not found.");
      return;
    }

    const configDir = getAccountConfigDir(context, id);
    try {
      credentials.moveCredentialsAside(configDir, "reauth-backup");
    } catch (e) {
      vscode.window.showWarningMessage((e as Error).message);
      return;
    }

    openClaudeLogin({
      configDir,
      terminalName: `Claude Login: ${profile.label}`,
    });

    const choice = await vscode.window.showInformationMessage(
      `Started isolated login for "${profile.label}". This does not change the current Claude Code account. Finish the login, then complete the reauthorization.`,
      "Complete reauthorization"
    );
    if (choice === "Complete reauthorization") {
      const res = await completeProfileReauthorization(id);
      vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      refreshUI();
    }
  };

  const poller = new UsagePoller(
    store,
    refresher,
    credentials,
    getInterval,
    refreshUI,
    (id) => credentials.readCurrent(getAccountConfigDir(context, id))
  );

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
      let res = await switchService.switchTo(targetId);
      if (!res.ok && res.reauthProfileId) {
        const completed = await completeProfileReauthorization(res.reauthProfileId, true);
        if (completed.ok) {
          res = await switchService.switchTo(targetId);
        } else if (!completed.missing) {
          vscode.window.showWarningMessage(completed.message);
        }
      }
      if (!res.ok) {
        if (res.reauthProfileId) {
          const choice = await vscode.window.showWarningMessage(
            `${res.message} Reauthorize this profile in an isolated Claude login so another saved account cannot overwrite it.`,
            "Reauthorize profile",
            "Complete reauthorization"
          );
          if (choice === "Reauthorize profile") {
            await startProfileReauthorization(res.reauthProfileId);
          } else if (choice === "Complete reauthorization") {
            const completed = await completeProfileReauthorization(res.reauthProfileId);
            vscode.window[completed.ok ? "showInformationMessage" : "showWarningMessage"](
              completed.message
            );
            if (completed.ok) {
              res = await switchService.switchTo(targetId);
              if (!res.ok) {
                vscode.window.showWarningMessage(res.message);
              }
            }
          }
        } else {
          vscode.window.showWarningMessage(res.message);
        }
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
    vscode.commands.registerCommand("claudeSwitcher.sayHi", async (id?: string) => {
      const targetIds = id ? [id] : await pickWarmupTargets(store);
      if (!targetIds || targetIds.length === 0) {
        return;
      }

      for (const targetId of targetIds) {
        const res = await warmupService.sayHi(targetId);
        vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
        if (res.ok) {
          await poller.pollOne(targetId, true);
        }
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.openIndependentWindow", async (id?: string) => {
      const targetIds = id ? [id] : await pickWindowTargets(store);
      if (!targetIds || targetIds.length === 0) {
        return;
      }

      for (const targetId of targetIds) {
        const res = await accountWindowService.open(targetId);
        vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.login", openClaudeLogin)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.reauthorizeProfile", async (id?: string) => {
      const targetId = id ?? (await pickAccount(store, "Reauthorize profile..."));
      if (targetId) {
        await startProfileReauthorization(targetId);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claudeSwitcher.completeProfileReauthorization",
      async (id?: string) => {
        const targetId = id ?? (await pickAccount(store, "Complete profile reauthorization..."));
        if (!targetId) {
          return;
        }
        const res = await completeProfileReauthorization(targetId);
        vscode.window[res.ok ? "showInformationMessage" : "showWarningMessage"](res.message);
        if (res.ok) {
          const profile = store.get(targetId);
          const choice = await vscode.window.showInformationMessage(
            `Switch to "${profile?.label ?? targetId}" now?`,
            "Switch now"
          );
          if (choice === "Switch now") {
            const switched = await switchService.switchTo(targetId);
            vscode.window[switched.ok ? "showInformationMessage" : "showWarningMessage"](
              switched.message
            );
          }
        }
        refreshUI();
      }
    )
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

  const items = accounts.map((p: AccountProfile) => {
    const u = p.lastUsage;
    const parts: string[] = [];
    if (typeof u?.sessionPercent === "number") parts.push(`5h: ${u.sessionPercent}%`);
    if (typeof u?.weeklyPercent === "number") parts.push(`weekly: ${u.weeklyPercent}%`);
    if (u?.error) parts.push("⚠ usage error");
    return {
      label: (p.id === activeId ? "$(check) " : "$(account) ") + p.label,
      description: [p.subscriptionType, parts.join("  ")].filter(Boolean).join("  ·  "),
      id: p.id,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Select an account",
    matchOnDescription: true,
  });
  return picked?.id;
}

async function pickWarmupTargets(store: AccountStore): Promise<string[] | undefined> {
  const accounts = store.list();
  const activeId = store.getActiveId();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No saved accounts. Use \"Save current account as profile\" first."
    );
    return undefined;
  }

  const inactive = accounts.filter((p) => p.id !== activeId);
  const items: Array<{ label: string; description?: string; ids: string[] }> = [];
  if (inactive.length > 1) {
    items.push({
      label: "$(run-all) Say Hi on all inactive accounts",
      description: `${inactive.length} accounts`,
      ids: inactive.map((p) => p.id),
    });
  }
  for (const p of accounts) {
    items.push({
      label: (p.id === activeId ? "$(circle-slash) " : "$(comment) ") + p.label,
      description:
        p.id === activeId
          ? "active account is skipped to avoid token races"
          : p.subscriptionType,
      ids: p.id === activeId ? [] : [p.id],
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Say Hi",
    placeHolder: "Select account to warm up",
    matchOnDescription: true,
  });
  return picked?.ids;
}

async function pickWindowTargets(store: AccountStore): Promise<string[] | undefined> {
  const accounts = store.list();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      "No saved accounts. Use \"Save current account as profile\" first."
    );
    return undefined;
  }

  const activeId = store.getActiveId();
  const items: Array<{ label: string; description?: string; ids: string[] }> = [];
  if (accounts.length > 1) {
    items.push({
      label: "$(run-all) Open all accounts in independent windows",
      description: `${accounts.length} windows`,
      ids: accounts.map((p) => p.id),
    });
  }
  for (const p of accounts) {
    items.push({
      label: (p.id === activeId ? "$(check) " : "$(window) ") + p.label,
      description: p.id === activeId ? "current account" : p.subscriptionType,
      ids: [p.id],
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "Open independent account window",
    placeHolder: "Select account",
    matchOnDescription: true,
  });
  return picked?.ids;
}

function profileHasIdentity(profile: AccountProfile): boolean {
  return Boolean(profileIdentity(profile));
}

function profileIdentity(profile: AccountProfile): ClaudeAuthIdentity | undefined {
  const email = normalizeEmail(profile.authEmail);
  const orgId = normalizeIdentityValue(profile.authOrgId);
  if (!email && !orgId) {
    return undefined;
  }
  return {
    email: profile.authEmail,
    orgId: profile.authOrgId,
    orgName: profile.authOrgName,
  };
}

function sameIdentity(a: ClaudeAuthIdentity, b: ClaudeAuthIdentity): boolean {
  const aOrgId = normalizeIdentityValue(a.orgId);
  const bOrgId = normalizeIdentityValue(b.orgId);
  if (aOrgId && bOrgId) {
    return aOrgId === bOrgId;
  }
  const aEmail = normalizeEmail(a.email);
  const bEmail = normalizeEmail(b.email);
  return Boolean(aEmail && bEmail && aEmail === bEmail);
}

function identityLabel(identity: ClaudeAuthIdentity): string {
  return identity.email ?? identity.orgName ?? identity.orgId ?? "unknown account";
}

function normalizeEmail(value: string | undefined): string | undefined {
  return normalizeIdentityValue(value)?.toLowerCase();
}

function normalizeIdentityValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
