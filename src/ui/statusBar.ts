import * as vscode from "vscode";
import { AccountStore } from "../accountStore";
import { identityLabel } from "../identity";
import { requiresProfileReauthorization } from "../oauth";
import { ClaudeAuthIdentity } from "../types";

/**
 * Status bar item: the active account + the 5h window usage %.
 * Clicking opens the quick account switcher.
 */
export class StatusBarController {
  private readonly item: vscode.StatusBarItem;
  private unsavedIdentity: ClaudeAuthIdentity | undefined;

  constructor(private readonly store: AccountStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "claudeSwitcher.switchAccount";
    this.item.show();
  }

  /** A logged-in Claude account that is not saved as a profile (or undefined). */
  setUnsavedIdentity(identity: ClaudeAuthIdentity | undefined): void {
    this.unsavedIdentity = identity;
    this.refresh();
  }

  refresh(): void {
    const activeId = this.store.getActiveId();
    const active = activeId ? this.store.get(activeId) : undefined;

    if (!active) {
      const unsaved = this.unsavedIdentity ? identityLabel(this.unsavedIdentity) : undefined;
      this.item.text = unsaved
        ? `$(account) Claude: ${unsaved} (not saved)`
        : "$(account) Claude: no account";
      this.item.tooltip = unsaved
        ? `Claude Code is logged in as ${unsaved}, which is not saved as a profile. Use "Save current account".`
        : "Click to add/switch a Claude account";
      this.item.backgroundColor = undefined;
      return;
    }

    const usage = active.lastUsage;
    const session = usage?.sessionPercent;
    const pctText = typeof session === "number" ? ` · ${session}%` : "";
    this.item.text = `$(account) ${active.label}${pctText}`;

    const lines = [`Active Claude account: ${active.label}`];
    if (usage) {
      for (const w of usage.windows) {
        lines.push(`  ${w.label}: ${w.percent}%`);
      }
      if (usage.error) {
        lines.push(`  ⚠ ${displayUsageError(usage.error)}`);
      }
    }
    lines.push("Click to switch account.");
    this.item.tooltip = lines.join("\n");

    const warn = vscode.workspace
      .getConfiguration("claudeSwitcher")
      .get<number>("warnThresholdPercent", 80);
    this.item.backgroundColor =
      typeof session === "number" && session >= warn
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function displayUsageError(error: string): string {
  return requiresProfileReauthorization(error)
    ? "Login was revoked or expired. Use Auth to reauthorize this profile."
    : error;
}
