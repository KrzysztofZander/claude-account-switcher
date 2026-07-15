import * as vscode from "vscode";
import { AccountStore } from "../accountStore";

interface ViewAccount {
  id: string;
  label: string;
  subscriptionType?: string;
  isActive: boolean;
  windows: { label: string; percent: number; severity: string; resetsAt: string | null }[];
  error?: string;
  fetchedAt?: number;
  retryAfter?: number;
}

/** Activity bar panel: list of accounts with usage limits and actions. */
export class AccountsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "claudeSwitcher.accountsView";
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: AccountStore
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type: string; id?: string }) => {
      switch (msg.type) {
        case "ready":
          this.refresh();
          break;
        case "switch":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.switchAccount", msg.id);
          break;
        case "openWindow":
          if (msg.id) {
            void vscode.commands.executeCommand("claudeSwitcher.openIndependentWindow", msg.id);
          }
          break;
        case "refresh":
          void vscode.commands.executeCommand("claudeSwitcher.refreshUsage", msg.id);
          break;
        case "refreshAll":
          void vscode.commands.executeCommand("claudeSwitcher.refreshUsage");
          break;
        case "sayHi":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.sayHi", msg.id);
          break;
        case "sayHiAll":
          void vscode.commands.executeCommand("claudeSwitcher.sayHi");
          break;
        case "add":
          void vscode.commands.executeCommand("claudeSwitcher.addCurrentAccount");
          break;
        case "login":
          void vscode.commands.executeCommand("claudeSwitcher.login");
          break;
        case "remove":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.removeAccount", msg.id);
          break;
        case "rename":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.renameAccount", msg.id);
          break;
        case "undo":
          void vscode.commands.executeCommand("claudeSwitcher.undoSwitch");
          break;
      }
    });

    this.refresh();
  }

  /** Sends the current state to the webview. */
  refresh(): void {
    if (!this.view) {
      return;
    }
    const activeId = this.store.getActiveId();
    const accounts: ViewAccount[] = this.store.list().map((p) => ({
      id: p.id,
      label: p.label,
      subscriptionType: p.subscriptionType,
      isActive: p.id === activeId,
      windows: p.lastUsage?.windows ?? [],
      error: p.lastUsage?.error,
      fetchedAt: p.lastUsage?.fetchedAt,
      retryAfter: p.lastUsage?.retryAfter,
    }));
    const warnThreshold = vscode.workspace
      .getConfiguration("claudeSwitcher")
      .get<number>("warnThresholdPercent", 80);

    void this.view.webview.postMessage({ type: "state", accounts, warnThreshold });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.css")
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Claude Accounts</title>
</head>
<body>
  <div id="toolbar">
    <button id="addBtn" class="primary">+ Save current account</button>
    <button id="loginBtn" title="Open Claude login">Login</button>
    <button id="sayHiBtn" title="Say Hi on inactive accounts">Hi</button>
    <button id="refreshBtn" title="Refresh usage limits">⟳</button>
  </div>
  <div id="list"></div>
  <div id="empty" class="hidden">
    <p>No saved accounts.</p>
    <p>Log in to Claude Code, then click <b>"Save current account"</b>.</p>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
