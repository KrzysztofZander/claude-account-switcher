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

export interface WriteCredsOptions {
  /**
   * Organization of the login being written. A string replaces the file's
   * `organizationUuid`, null removes a value left behind by another account, and
   * undefined keeps it (a token rotation of the same login).
   */
  organizationUuid?: string | null;
}

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

  /** The config directory plain Claude Code sessions (terminals, regular windows) use. */
  getGlobalConfigDir(): string {
    const env = process.env.CLAUDE_CONFIG_DIR?.trim();
    return env ? env : path.join(os.homedir(), ".claude");
  }

  /**
   * Claude Code keeps account metadata (`oauthAccount`) in `~/.claude.json` for the
   * default config dir and in `<dir>/.claude.json` when CLAUDE_CONFIG_DIR is set.
   */
  getGlobalConfigFile(configDir: string = this.getConfigDir()): string {
    const defaultDir = path.join(os.homedir(), ".claude");
    const isDefault =
      process.platform === "win32"
        ? path.resolve(configDir).toLowerCase() === path.resolve(defaultDir).toLowerCase()
        : path.resolve(configDir) === path.resolve(defaultDir);
    return isDefault && !process.env.CLAUDE_CONFIG_DIR?.trim()
      ? path.join(os.homedir(), ".claude.json")
      : path.join(configDir, ".claude.json");
  }

  readOAuthAccount(configDir?: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.getGlobalConfigFile(configDir), "utf8")
      ) as { oauthAccount?: unknown };
      const account = parsed.oauthAccount;
      return account && typeof account === "object" && !Array.isArray(account)
        ? (account as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Replaces only the `oauthAccount` key of Claude Code's global config, so the
   * cached account details (email, organization) match the tokens just written.
   * Leaves the file untouched when it cannot be parsed.
   */
  writeOAuthAccount(account: Record<string, unknown>, configDir?: string): boolean {
    const file = this.getGlobalConfigFile(configDir);
    try {
      let config: Record<string, unknown> = {};
      if (fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return false;
        }
        config = parsed as Record<string, unknown>;
      }
      config.oauthAccount = account;
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
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
  writeCreds(creds: OAuthCreds, configDir?: string, options: WriteCredsOptions = {}): void {
    if (!hasUsableOAuthCreds(creds)) {
      throw new Error("Refusing to write incomplete Claude OAuth credentials.");
    }

    const p = this.getCredentialsPath(configDir);
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });

    const existing = this.readRawFile(configDir) ?? ({} as CredentialsFile);
    const next: CredentialsFile = { ...existing, claudeAiOauth: creds };
    if (options.organizationUuid === null) {
      delete next.organizationUuid;
    } else if (options.organizationUuid !== undefined) {
      next.organizationUuid = options.organizationUuid;
    }
    const json = JSON.stringify(next, null, 2);

    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
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

  private backupPath(): string {
    return this.getCredentialsPath() + ".bak";
  }

  /** Tokens saved by the last switch (used to undo it). */
  readBackup(): OAuthCreds | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.backupPath(), "utf8")) as Partial<CredentialsFile>;
      return hasAccessToken(parsed.claudeAiOauth) ? (parsed.claudeAiOauth as OAuthCreds) : null;
    } catch {
      return null;
    }
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

  /** Moves an existing credentials file out of the way before a forced repair login. */
  moveCredentialsAside(configDir?: string, reason = "backup"): string | null {
    const p = this.getCredentialsPath(configDir);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (!fs.existsSync(p)) {
        return null;
      }
      const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
      const target = `${p}.${reason}-${stamp}`;
      fs.renameSync(p, target);
      return target;
    } catch (e) {
      throw new Error("Failed to move existing credentials aside: " + (e as Error).message);
    }
  }
}
