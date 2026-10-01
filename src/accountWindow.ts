import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { CredentialSync } from "./credentialSync";
import { hasUsableOAuthCreds } from "./credentialValidation";
import { CredentialsManager } from "./credentials";
import { getAccountConfigDir } from "./isolatedConfig";
import { ProfileActivityRegistry } from "./profileActivity";

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
    private readonly credentials: CredentialsManager,
    private readonly sync: CredentialSync,
    private readonly profileActivity?: ProfileActivityRegistry
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
    if (!hasUsableOAuthCreds(creds)) {
      return {
        ok: false,
        message:
          `"${profile.label}" needs reauthorization. Use "Claude: Reauthorize account profile" for this profile first.`,
      };
    }
    if (this.profileActivity?.isActive(id, { excludeSelf: true })) {
      return {
        ok: false,
        message:
          `"${profile.label}" is already active in another VS Code window. ` +
          "Close or switch that window before opening another session for the same account.",
      };
    }

    const current = await this.sync.syncCurrent();
    if (current.ownerId === id) {
      return {
        ok: false,
        message:
          `"${profile.label}" is the account of this window's Claude Code. ` +
          "Switch this window to another account first, so two sessions do not share one refresh token.",
      };
    }

    this.profileActivity?.markPending(id);
    const configDir = getAccountConfigDir(this.context, id);
    const prepared = await this.sync.prepareHomeDir(id);
    if (!prepared.ok) {
      return {
        ok: false,
        message: prepared.deferred
          ? `Token refresh is already running for "${profile.label}". Try again in a few seconds.`
          : `"${profile.label}" needs reauthorization. Use "Claude: Reauthorize account profile" first.`,
      };
    }

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
