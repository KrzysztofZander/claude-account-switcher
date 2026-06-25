import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { CredentialsManager } from "./credentials";

/**
 * Orchestration: capturing the current account, switching (swapping the file),
 * reloading the window, and undoing the last switch.
 */
export class SwitchService {
  constructor(
    private readonly store: AccountStore,
    private readonly credentials: CredentialsManager
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

    const existingId = await this.store.findByTokens(creds);
    if (existingId) {
      const existing = this.store.get(existingId);
      await this.store.setActiveId(existingId);
      return {
        ok: false,
        message: `This account is already saved as "${existing?.label ?? existingId}".`,
      };
    }

    const suggested = creds.subscriptionType
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

    const profile = await this.store.addFromCreds(label.trim(), creds);
    return { ok: true, message: `Saved profile "${profile.label}".` };
  }

  /** Switches to the given profile: backup + write to file + (optionally) reload. */
  async switchTo(id: string): Promise<{ ok: boolean; message: string }> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: "Profile not found." };
    }
    if (this.store.getActiveId() === id) {
      return { ok: false, message: `"${profile.label}" is already active.` };
    }
    const creds = await this.store.getCreds(id);
    if (!creds) {
      return { ok: false, message: "No stored credentials for this profile." };
    }

    this.credentials.backupCurrent();
    try {
      this.credentials.writeCreds(creds);
    } catch (e) {
      return { ok: false, message: "Failed to write credentials file: " + (e as Error).message };
    }
    await this.store.setActiveId(id);

    await this.maybeReload(`Switched to "${profile.label}".`);
    return { ok: true, message: `Switched to "${profile.label}".` };
  }

  /** Undoes the last switch by restoring the file from the .bak copy. */
  async undoSwitch(): Promise<{ ok: boolean; message: string }> {
    if (!this.credentials.hasBackup()) {
      return { ok: false, message: "No backup to restore." };
    }
    const ok = this.credentials.restoreBackup();
    if (!ok) {
      return { ok: false, message: "Failed to restore the backup." };
    }
    // Update activeId based on the restored file.
    const restored = this.credentials.readCurrent();
    const matched = restored ? await this.store.findByTokens(restored) : undefined;
    await this.store.setActiveId(matched);

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
