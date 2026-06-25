import * as crypto from "crypto";
import * as vscode from "vscode";
import { AccountProfile, OAuthCreds, UsageSnapshot } from "./types";

const PROFILES_KEY = "claudeSwitcher.profiles";
const ACTIVE_KEY = "claudeSwitcher.activeId";
const SECRET_PREFIX = "claudeSwitcher.account.";

/**
 * Stores account profiles. Metadata (list, order, last usage snapshot) is kept in
 * globalState; secrets (OAuth tokens) in the encrypted SecretStorage.
 *
 * The "active" account is the one whose tokens are currently in .credentials.json.
 * Because Claude Code rotates tokens, the source of truth is the remembered
 * `activeId`, and we sync the active profile's creds from the file (syncActiveFromFile).
 */
export class AccountStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get profiles(): AccountProfile[] {
    return this.context.globalState.get<AccountProfile[]>(PROFILES_KEY, []);
  }

  private async saveProfiles(profiles: AccountProfile[]): Promise<void> {
    await this.context.globalState.update(PROFILES_KEY, profiles);
  }

  list(): AccountProfile[] {
    return [...this.profiles].sort((a, b) => a.order - b.order);
  }

  get(id: string): AccountProfile | undefined {
    return this.profiles.find((p) => p.id === id);
  }

  getActiveId(): string | undefined {
    return this.context.globalState.get<string>(ACTIVE_KEY);
  }

  async setActiveId(id: string | undefined): Promise<void> {
    await this.context.globalState.update(ACTIVE_KEY, id);
  }

  private secretKey(id: string): string {
    return SECRET_PREFIX + id;
  }

  async getCreds(id: string): Promise<OAuthCreds | null> {
    const raw = await this.context.secrets.get(this.secretKey(id));
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as OAuthCreds;
    } catch {
      return null;
    }
  }

  private async setCreds(id: string, creds: OAuthCreds): Promise<void> {
    await this.context.secrets.store(this.secretKey(id), JSON.stringify(creds));
  }

  /** Creates a new profile from the given creds and marks it active. */
  async addFromCreds(label: string, creds: OAuthCreds): Promise<AccountProfile> {
    const profiles = this.profiles;
    const maxOrder = profiles.reduce((m, p) => Math.max(m, p.order), -1);
    const profile: AccountProfile = {
      id: crypto.randomUUID(),
      label,
      subscriptionType: creds.subscriptionType,
      addedAt: Date.now(),
      order: maxOrder + 1,
    };
    profiles.push(profile);
    await this.saveProfiles(profiles);
    await this.setCreds(profile.id, creds);
    await this.setActiveId(profile.id);
    return profile;
  }

  async remove(id: string): Promise<void> {
    const profiles = this.profiles.filter((p) => p.id !== id);
    await this.saveProfiles(profiles);
    await this.context.secrets.delete(this.secretKey(id));
    if (this.getActiveId() === id) {
      await this.setActiveId(undefined);
    }
  }

  async rename(id: string, label: string): Promise<void> {
    const profiles = this.profiles;
    const p = profiles.find((x) => x.id === id);
    if (p) {
      p.label = label;
      await this.saveProfiles(profiles);
    }
  }

  async updateUsage(id: string, usage: UsageSnapshot): Promise<void> {
    const profiles = this.profiles;
    const p = profiles.find((x) => x.id === id);
    if (p) {
      p.lastUsage = usage;
      await this.saveProfiles(profiles);
    }
  }

  /** Overwrites a profile's tokens (e.g. after a refresh) and updates the subscription type. */
  async updateCreds(id: string, creds: OAuthCreds): Promise<void> {
    await this.setCreds(id, creds);
    const profiles = this.profiles;
    const p = profiles.find((x) => x.id === id);
    if (p && creds.subscriptionType && p.subscriptionType !== creds.subscriptionType) {
      p.subscriptionType = creds.subscriptionType;
      await this.saveProfiles(profiles);
    }
  }

  /** Finds a profile with matching tokens (to detect duplicates / the active one). */
  async findByTokens(creds: OAuthCreds): Promise<string | undefined> {
    for (const p of this.profiles) {
      const stored = await this.getCreds(p.id);
      if (
        stored &&
        (stored.accessToken === creds.accessToken ||
          stored.refreshToken === creds.refreshToken)
      ) {
        return p.id;
      }
    }
    return undefined;
  }

  /**
   * Syncs the active profile's creds with the current file (the file is the source of
   * truth for the active account, since Claude Code rotates tokens). If the file matches
   * a different profile, switches activeId to that profile.
   */
  async syncActiveFromFile(fileCreds: OAuthCreds | null): Promise<void> {
    if (!fileCreds) {
      return;
    }
    const matched = await this.findByTokens(fileCreds);
    if (matched) {
      await this.setActiveId(matched);
      await this.updateCreds(matched, fileCreds);
      return;
    }
    // No match (e.g. token rotation) — refresh the remembered active profile.
    const activeId = this.getActiveId();
    if (activeId && this.get(activeId)) {
      await this.updateCreds(activeId, fileCreds);
    }
  }
}
