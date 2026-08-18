import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  hasAccessToken,
  hasUsableOAuthCreds,
  sameNonEmptyToken,
} from "./credentialValidation";
import { CredentialsFile, OAuthCreds } from "./types";

const KEPT_SET_ASIDE_CREDENTIALS = 2;

/**
 * Reads and writes the Claude Code credentials file (~/.claude/.credentials.json).
 * Switching accounts = swapping the contents of this file.
 */
export class CredentialsManager {
  constructor(private readonly isolatedConfigRoot?: string) {}

  getCredentialsPath(configDir?: string): string {
    if (configDir) {
      return path.join(configDir, ".credentials.json");
    }

    const override = this.configuredCredentialsPath();
    if (override) {
      return override;
    }
    return path.join(os.homedir(), ".claude", ".credentials.json");
  }

  /** Resolves `credentialsPath`; a workspace value is honoured only for isolated configs. */
  private configuredCredentialsPath(): string {
    const cfg = vscode.workspace.getConfiguration("claudeSwitcher");
    const inspected = cfg.inspect
      ? cfg.inspect<string>("credentialsPath")
      : undefined;
    if (!inspected) {
      return trimmedValue(cfg.get<string>("credentialsPath", ""));
    }

    for (const scoped of [inspected.workspaceFolderValue, inspected.workspaceValue]) {
      const value = trimmedValue(scoped);
      if (value && this.isIsolatedAccountConfig(value)) {
        return value;
      }
    }
    return trimmedValue(inspected.globalValue);
  }

  private isIsolatedAccountConfig(candidate: string): boolean {
    if (!this.isolatedConfigRoot) {
      return false;
    }
    const normalize = (value: string) =>
      process.platform === "win32"
        ? path.resolve(value).toLowerCase()
        : path.resolve(value);
    return normalize(candidate).startsWith(normalize(this.isolatedConfigRoot) + path.sep);
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
      if (hasAccessToken(oauth)) {
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
    if (!hasUsableOAuthCreds(creds)) {
      throw new Error("Refusing to write incomplete Claude OAuth credentials.");
    }

    const p = this.getCredentialsPath(configDir);
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

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

  /**
   * Replaces a rotating-token credential file only while it still contains the
   * refresh token that was just spent. If Claude Code won the race and already
   * wrote a newer generation, that newer file is left untouched.
   */
  writeCredsIfCurrent(
    expected: OAuthCreds,
    next: OAuthCreds,
    configDir?: string
  ): boolean {
    const current = this.readCurrent(configDir);
    if (!current || !sameNonEmptyToken(current.refreshToken, expected.refreshToken)) {
      return false;
    }
    this.writeCreds(next, configDir);
    return true;
  }

  removeCredentials(configDir?: string): void {
    try {
      fs.rmSync(this.getCredentialsPath(configDir), { force: true });
    } catch {
      /* already absent */
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
        // copyFileSync keeps the destination's mode when .bak already exists.
        try {
          fs.chmodSync(this.backupPath(), 0o600);
        } catch {
          /* best-effort on Windows */
        }
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  discardBackup(): void {
    try {
      fs.rmSync(this.backupPath(), { force: true });
    } catch {
      /* already absent */
    }
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

  /** Moves an existing credentials file out of the way before a forced repair login. */
  moveCredentialsAside(configDir?: string, reason = "backup"): string | null {
    const p = this.getCredentialsPath(configDir);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(p)) {
        return null;
      }
      const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
      const target = `${p}.${reason}-${stamp}`;
      fs.renameSync(p, target);
      try {
        fs.chmodSync(target, 0o600);
      } catch {
        /* best-effort on Windows */
      }
      this.pruneSetAsideCredentials(p, reason);
      return target;
    } catch (e) {
      throw new Error("Failed to move existing credentials aside: " + (e as Error).message);
    }
  }

  private pruneSetAsideCredentials(credentialsPath: string, reason: string): void {
    const dir = path.dirname(credentialsPath);
    const prefix = path.basename(credentialsPath) + `.${reason}-`;
    try {
      const stale = fs
        .readdirSync(dir)
        .filter((name) => name.startsWith(prefix))
        .sort()
        .slice(0, -KEPT_SET_ASIDE_CREDENTIALS);
      for (const name of stale) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    } catch {
      /* best-effort; must never fail the reauthorization */
    }
  }
}

function trimmedValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
