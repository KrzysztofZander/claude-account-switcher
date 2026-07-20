import * as crypto from "crypto";
import * as vscode from "vscode";
import { sameNonEmptyToken } from "./credentialValidation";
import { AccountProfile, ClaudeAuthIdentity, OAuthCreds, UsageSnapshot } from "./types";

const PROFILES_KEY = "claudeSwitcher.profiles";
const ACTIVE_KEY = "claudeSwitcher.activeId";
const SECRET_PREFIX = "claudeSwitcher.account.";

/**
 * Stores account profiles. Metadata (list, order, last usage snapshot) is kept in
 * globalState; secrets (OAuth tokens) in the encrypted SecretStorage. The active
 * account id is workspace-scoped so independent VS Code windows can use different
 * accounts without racing through one global marker.
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
    return this.context.workspaceState.get<string>(ACTIVE_KEY);
  }

  async setActiveId(id: string | undefined): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_KEY, id);
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

  async updateIdentity(id: string, identity: ClaudeAuthIdentity): Promise<void> {
    const profiles = this.profiles;
    const p = profiles.find((x) => x.id === id);
    if (p) {
      p.authEmail = identity.email;
      p.authOrgId = identity.orgId;
      p.authOrgName = identity.orgName;
      await this.saveProfiles(profiles);
    }
  }

  findByIdentity(identity: ClaudeAuthIdentity, exceptId?: string): AccountProfile | undefined {
    const email = normalizeEmail(identity.email);
    const orgId = normalizeIdentityValue(identity.orgId);
    if (!email && !orgId) {
      return undefined;
    }

    return this.profiles.find((p) => {
      if (p.id === exceptId) {
        return false;
      }
      const profileOrgId = normalizeIdentityValue(p.authOrgId);
      const profileEmail = normalizeEmail(p.authEmail);
      return Boolean((orgId && profileOrgId === orgId) || (email && profileEmail === email));
    });
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
        (sameNonEmptyToken(stored.accessToken, creds.accessToken) ||
          sameNonEmptyToken(stored.refreshToken, creds.refreshToken))
      ) {
        return p.id;
      }
    }
    return undefined;
  }

  /**
   * Syncs the active profile's creds with the current file. If the file matches
   * a saved profile, that profile becomes active and receives the freshest tokens.
   *
   * If the file does not match any saved profile, we intentionally do not overwrite the
   * remembered active profile. That case can mean "same account rotated both tokens",
   * but it can also mean the user manually logged in to another account. Overwriting here
   * would destroy the stored profile and is a common cause of later login failures.
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
    const activeId = this.getActiveId();
    const activeCreds = activeId ? await this.getCreds(activeId) : null;
    if (
      activeId &&
      this.get(activeId) &&
      activeCreds &&
      (sameNonEmptyToken(activeCreds.accessToken, fileCreds.accessToken) ||
        sameNonEmptyToken(activeCreds.refreshToken, fileCreds.refreshToken))
    ) {
      await this.updateCreds(activeId, fileCreds);
      return;
    }

    if (activeId) {
      await this.setActiveId(undefined);
    }
  }
}

function normalizeEmail(value: string | undefined): string | undefined {
  return normalizeIdentityValue(value)?.toLowerCase();
}

function normalizeIdentityValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
