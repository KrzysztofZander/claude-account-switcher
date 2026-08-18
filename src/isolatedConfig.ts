import * as path from "path";
import * as vscode from "vscode";

/** Root holding every profile's isolated Claude config directory. */
export function getAccountConfigRoot(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "account-configs");
}

export function getAccountConfigDir(context: vscode.ExtensionContext, id: string): string {
  return path.join(getAccountConfigRoot(context), id);
}
