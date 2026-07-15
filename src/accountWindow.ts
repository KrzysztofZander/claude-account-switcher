import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { CredentialsManager } from "./credentials";
import { getAccountConfigDir } from "./isolatedConfig";

export interface AccountWindowResult {
  ok: boolean;
  message: string;
}

interface WorkspaceFile {
  folders: Array<{ path: string }>;
  settings: Record<string, unknown>;
}

export class AccountWindowService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: AccountStore,
    private readonly credentials: CredentialsManager
  ) {}

  async open(id: string): Promise<AccountWindowResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: "Profile not found." };
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return {
        ok: false,
        message: "Open a folder or workspace first, then open an independent account window.",
      };
    }

    const creds = await this.store.getCreds(id);
    if (!creds) {
      return { ok: false, message: `No stored credentials for "${profile.label}".` };
    }

    const configDir = getAccountConfigDir(this.context, id);
    fs.mkdirSync(configDir, { recursive: true });
    this.credentials.writeCreds(creds, configDir);

    const workspacePath = this.getWorkspacePath(id, workspaceFolders);
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    fs.writeFileSync(
      workspacePath,
      JSON.stringify(this.createWorkspaceFile(workspaceFolders, configDir), null, 2),
      "utf8"
    );

    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(workspacePath),
      true
    );

    return { ok: true, message: `Opened "${profile.label}" in an independent VS Code window.` };
  }

  private createWorkspaceFile(
    folders: readonly vscode.WorkspaceFolder[],
    configDir: string
  ): WorkspaceFile {
    return {
      folders: folders.map((folder) => ({ path: folder.uri.fsPath })),
      settings: {
        "claudeCode.environmentVariables": [
          {
            name: "CLAUDE_CONFIG_DIR",
            value: configDir,
          },
        ],
        "claudeSwitcher.credentialsPath": this.credentials.getCredentialsPath(configDir),
      },
    };
  }

  private getWorkspacePath(id: string, folders: readonly vscode.WorkspaceFolder[]): string {
    const workspaceKey = folders.map((folder) => folder.uri.fsPath).join("|");
    const hash = crypto.createHash("sha256").update(workspaceKey).digest("hex").slice(0, 12);
    return path.join(
      this.context.globalStorageUri.fsPath,
      "workspaces",
      `${id}-${hash}.code-workspace`
    );
  }
}
