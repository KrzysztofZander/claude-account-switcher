import * as path from "path";
import * as vscode from "vscode";

export function getAccountConfigDir(context: vscode.ExtensionContext, id: string): string {
  return path.join(context.globalStorageUri.fsPath, "account-configs", id);
}
