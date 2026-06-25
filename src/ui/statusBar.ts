import * as vscode from "vscode";
import { AccountStore } from "../accountStore";

/**
 * Status bar item: the active account + 5h/7-day usage as "5h%-7d%".
 * Clicking opens the quick account switcher.
 */
export class StatusBarController {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly store: AccountStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "claudeSwitcher.switchAccount";
    this.item.show();
  }

  refresh(): void {
    const activeId = this.store.getActiveId();
    const active = activeId ? this.store.get(activeId) : undefined;

    if (!active) {
      this.item.text = "$(account) Claude: no account";
      this.item.tooltip = "Click to add/switch a Claude account";
      this.item.backgroundColor = undefined;
      return;
    }

    const usage = active.lastUsage;
    const session = usage?.sessionPercent;
    const weekly = usage?.weeklyPercent;
    let pctText = "";
    if (typeof session === "number" && typeof weekly === "number") {
      pctText = ` · ${session}%-${weekly}%`;
    } else if (typeof session === "number") {
      pctText = ` · ${session}%`;
    }
    this.item.text = `$(account) ${active.label}${pctText}`;

    const lines = [`Active Claude account: ${active.label}`];
    if (usage) {
      for (const w of usage.windows) {
        lines.push(`  ${w.label}: ${w.percent}%`);
      }
      if (usage.error) {
        lines.push(`  ⚠ ${usage.error}`);
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
