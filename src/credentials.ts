import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CredentialsFile, OAuthCreds } from "./types";

/**
 * Reads and writes the Claude Code credentials file (~/.claude/.credentials.json).
 * Switching accounts = swapping the contents of this file.
 */
export class CredentialsManager {
  getCredentialsPath(configDir?: string): string {
    if (configDir) {
      return path.join(configDir, ".credentials.json");
    }

    const override = vscode.workspace
      .getConfiguration("claudeSwitcher")
      .get<string>("credentialsPath", "")
      .trim();
    if (override) {
      return override;
    }
    return path.join(os.homedir(), ".claude", ".credentials.json");
  }

  getConfigDir(): string {
    return path.dirname(this.getCredentialsPath());
  }

  exists(): boolean {
    try {
      return fs.existsSync(this.getCredentialsPath());
    } catch {
      return false;
    }
  }

  /** Returns the claudeAiOauth object from the file, or null if missing/invalid. */
  readCurrent(configDir?: string): OAuthCreds | null {
    const p = this.getCredentialsPath(configDir);
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
      const oauth = parsed.claudeAiOauth;
      if (oauth && typeof oauth.accessToken === "string") {
        return oauth as OAuthCreds;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Returns the full file contents (to preserve any extra fields). */
  private readRawFile(configDir?: string): CredentialsFile | null {
    try {
      const raw = fs.readFileSync(this.getCredentialsPath(configDir), "utf8");
      return JSON.parse(raw) as CredentialsFile;
    } catch {
      return null;
    }
  }

  /**
   * Writes creds to the file atomically (tmp -> rename), preserving any other
   * fields that were already present.
   */
  writeCreds(creds: OAuthCreds, configDir?: string): void {
    const p = this.getCredentialsPath(configDir);
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });

    const existing = this.readRawFile(configDir) ?? ({} as CredentialsFile);
    const next: CredentialsFile = { ...existing, claudeAiOauth: creds };
    const json = JSON.stringify(next, null, 2);

    const tmp = p + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, json, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, p);
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* best-effort on Windows */
    }
  }

  private backupPath(): string {
    return this.getCredentialsPath() + ".bak";
  }

  /** Copies the current file to .bak (enables undoing a switch). */
  backupCurrent(): boolean {
    const p = this.getCredentialsPath();
    try {
      if (fs.existsSync(p)) {
        fs.copyFileSync(p, this.backupPath());
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  hasBackup(): boolean {
    try {
      return fs.existsSync(this.backupPath());
    } catch {
      return false;
    }
  }

  /** Restores the file from .bak. Returns true on success. */
  restoreBackup(): boolean {
    const bak = this.backupPath();
    const p = this.getCredentialsPath();
    try {
      if (fs.existsSync(bak)) {
        fs.copyFileSync(bak, p);
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }
}
