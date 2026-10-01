import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { CredentialSync } from "./credentialSync";
import { hasUsableOAuthCreds } from "./credentialValidation";
import { CredentialsManager } from "./credentials";
import { identityLabel } from "./identity";

export interface SwitchResult {
  ok: boolean;
  message: string;
  reauthProfileId?: string;
}

/**
 * Orchestration: capturing the current account, switching (swapping the file),
 * reloading the window, and undoing the last switch.
 */
export class SwitchService {
  constructor(
    private readonly store: AccountStore,
    private readonly credentials: CredentialsManager,
    private readonly sync: CredentialSync,
    private readonly isActiveElsewhere: (id: string) => boolean = () => false
  ) {}

  /** Saves the currently logged-in account (from the file) as a new profile. */
  async captureCurrent(): Promise<{ ok: boolean; message: string }> {
    const creds = this.credentials.readCurrent();
    if (!creds) {
      return {
        ok: false,
        message:
          "No logged-in account found in .credentials.json. Log in to Claude Code and try again.",
      };
    }
    if (!hasUsableOAuthCreds(creds)) {
      return {
        ok: false,
        message:
          "Current Claude credentials are incomplete. Run Claude: Log in from terminal, finish login, then save the account again.",
      };
    }

    const owner = await this.sync.resolveFileOwner(this.credentials.getConfigDir());
    if (owner.ownerId) {
      const existing = this.store.get(owner.ownerId);
      await this.sync.syncCurrent();
      return {
        ok: true,
        message: `Updated saved profile "${existing?.label ?? owner.ownerId}".`,
      };
    }

    const suggested = owner.identity?.email
      ? owner.identity.email
      : creds.subscriptionType
        ? `${creds.subscriptionType} account`
        : "New account";
    const label = await vscode.window.showInputBox({
      title: "Save current Claude account",
      prompt: "Profile name (e.g. Work, Personal, Max #1)",
      value: suggested,
      validateInput: (v) => (v.trim().length === 0 ? "Enter a name" : undefined),
    });
    if (label === undefined) {
      return { ok: false, message: "Cancelled." };
    }

    const profile = await this.store.addFromCreds(label.trim(), creds, {
      identity: owner.identity,
    });
    await this.sync.captureOAuthAccount(profile.id, this.credentials.getConfigDir());
    return { ok: true, message: `Saved profile "${profile.label}".` };
  }

  /** Switches to the given profile: save outgoing login + write target + (optionally) reload. */
  async switchTo(id: string): Promise<SwitchResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: "Profile not found." };
    }
    const stored = await this.store.getCreds(id);
    if (!stored || !hasUsableOAuthCreds(stored)) {
      return {
        ok: false,
        message:
          `"${profile.label}" needs reauthorization. Its stored credentials are incomplete, so it was not written to Claude Code.`,
        reauthProfileId: id,
      };
    }

    // Capture the outgoing login first: Claude Code may have rotated it since the
    // last poll, and that rotation must reach its profile before the file changes.
    const current = await this.sync.syncCurrent();
    if (current.ownerId === id) {
      return { ok: false, message: `"${profile.label}" is already active.` };
    }
    if (this.isActiveElsewhere(id)) {
      return {
        ok: false,
        message:
          `"${profile.label}" is in use in another VS Code window. Close that window first, ` +
          "so two Claude Code sessions do not spend the same single-use refresh token.",
      };
    }
    if (current.unsavedIdentity) {
      const choice = await vscode.window.showWarningMessage(
        `The current Claude login (${identityLabel(current.unsavedIdentity)}) is not saved as a profile. ` +
          "Save it before switching?",
        { modal: true },
        "Save and switch",
        "Switch without saving"
      );
      if (!choice) {
        return { ok: false, message: "Cancelled." };
      }
      if (choice === "Save and switch") {
        const saved = await this.captureCurrent();
        if (!saved.ok) {
          return saved;
        }
      }
    }

    let installed: Awaited<ReturnType<CredentialSync["installInConfigDir"]>>;
    try {
      installed = await this.sync.installInConfigDir(
        id,
        this.credentials.getConfigDir(),
        current.ownerId
      );
    } catch (e) {
      return { ok: false, message: "Failed to write credentials file: " + (e as Error).message };
    }
    if (!installed.ok) {
      if (installed.needsReauthorization) {
        return {
          ok: false,
          message: `"${profile.label}" needs reauthorization: its saved login was rejected by Claude.`,
          reauthProfileId: id,
        };
      }
      return { ok: false, message: installed.message ?? "Switch failed." };
    }

    await this.maybeReload(`Switched to "${profile.label}".`);
    return { ok: true, message: `Switched to "${profile.label}".` };
  }

  /**
   * Undoes the last switch. A saved profile is restored from its newest token
   * generation — the raw .bak copy may hold a refresh token that was rotated since.
   */
  async undoSwitch(): Promise<{ ok: boolean; message: string }> {
    const backup = this.credentials.readBackup();
    if (!backup) {
      return { ok: false, message: "No backup to restore." };
    }

    const ownerId =
      (await this.store.findByTokens(backup)) ??
      (await (async () => {
        const identity = await this.sync.identify(backup);
        return identity ? this.store.findByIdentity(identity)?.id : undefined;
      })());
    if (ownerId) {
      const res = await this.switchTo(ownerId);
      return { ok: res.ok, message: res.ok ? "Restored the previous account." : res.message };
    }

    if (!this.credentials.restoreBackup()) {
      return { ok: false, message: "Failed to restore the backup." };
    }
    await this.store.setActiveId(undefined);
    await this.maybeReload("Restored the previous account.");
    return { ok: true, message: "Restored the previous account." };
  }

  /** Reload the window automatically or after confirmation (per setting). */
  private async maybeReload(context: string): Promise<void> {
    const auto = vscode.workspace
      .getConfiguration("claudeSwitcher")
      .get<boolean>("autoReloadAfterSwitch", false);

    if (auto) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `${context} Reload the VS Code window so Claude Code uses the new account.`,
      "Reload now",
      "Later"
    );
    if (choice === "Reload now") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }
}
