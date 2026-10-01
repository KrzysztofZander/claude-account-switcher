import * as crypto from "crypto";
import * as vscode from "vscode";
import {
  sameNonEmptyToken,
  shouldPreferCredentialCandidate,
} from "./credentialValidation";
import { hasIdentity, profileMatchesIdentity } from "./identity";
import { tokenFingerprint } from "./oauth";
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
 * Claude Code rotates those tokens, so CredentialSync keeps the vault copy in step
 * with every credentials file that holds the same login.
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

  /**
   * Creates a new profile from the given creds. By default it is marked active
   * (it came from the current credentials file); isolated logins pass
   * `activate: false` and their pre-allocated id so their config dir matches.
   */
  async addFromCreds(
    label: string,
    creds: OAuthCreds,
    options: { id?: string; identity?: ClaudeAuthIdentity; activate?: boolean } = {}
  ): Promise<AccountProfile> {
    const profiles = this.profiles;
    const maxOrder = profiles.reduce((m, p) => Math.max(m, p.order), -1);
    const profile: AccountProfile = {
      id: options.id ?? crypto.randomUUID(),
      label,
      subscriptionType: creds.subscriptionType,
      authAccountUuid: options.identity?.accountUuid,
      authEmail: options.identity?.email,
      authOrgId: options.identity?.orgId,
      authOrgName: options.identity?.orgName,
      addedAt: Date.now(),
      order: maxOrder + 1,
    };
    profiles.push(profile);
    await this.saveProfiles(profiles);
    await this.setCreds(profile.id, creds);
    if (options.activate !== false) {
      await this.setActiveId(profile.id);
    }
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

  async clearUsageError(id: string): Promise<void> {
    const profiles = this.profiles;
    const p = profiles.find((x) => x.id === id);
    if (!p?.lastUsage || (!p.lastUsage.error && !p.lastUsage.retryAfter)) {
      return;
    }

    const next = { ...p.lastUsage };
    delete next.error;
    delete next.retryAfter;
    p.lastUsage = next;
    await this.saveProfiles(profiles);
  }

  async updateIdentity(id: string, identity: ClaudeAuthIdentity): Promise<void> {
    const profiles = this.profiles;
    const p = profiles.find((x) => x.id === id);
    if (!p) {
      return;
    }
    const next = {
      authAccountUuid: identity.accountUuid ?? p.authAccountUuid,
      authEmail: identity.email ?? p.authEmail,
      authOrgId: identity.orgId ?? p.authOrgId,
      authOrgName: identity.orgName ?? p.authOrgName,
    };
    if (
      next.authAccountUuid !== p.authAccountUuid ||
      next.authEmail !== p.authEmail ||
      next.authOrgId !== p.authOrgId ||
      next.authOrgName !== p.authOrgName
    ) {
      Object.assign(p, next);
      await this.saveProfiles(profiles);
    }
  }

  async setOAuthAccount(id: string, account: Record<string, unknown>): Promise<void> {
    const profiles = this.profiles;
    const p = profiles.find((x) => x.id === id);
    if (p && JSON.stringify(p.oauthAccount) !== JSON.stringify(account)) {
      p.oauthAccount = account;
      await this.saveProfiles(profiles);
    }
  }

  /** Remembers that the server rejected this refresh token (invalid_grant). */
  async markRefreshTokenDead(id: string, refreshToken: string): Promise<void> {
    const profiles = this.profiles;
    const p = profiles.find((x) => x.id === id);
    if (p && refreshToken) {
      p.deadRefreshTokenHash = tokenFingerprint(refreshToken);
      await this.saveProfiles(profiles);
    }
  }

  isRefreshTokenDead(id: string, refreshToken: string | undefined): boolean {
    const hash = this.get(id)?.deadRefreshTokenHash;
    return Boolean(hash && refreshToken && tokenFingerprint(refreshToken) === hash);
  }

  findByIdentity(identity: ClaudeAuthIdentity, exceptId?: string): AccountProfile | undefined {
    if (!hasIdentity(identity)) {
      return undefined;
    }
    return this.profiles.find(
      (p) => p.id !== exceptId && profileMatchesIdentity(p, identity)
    );
  }

  /** Overwrites a profile's tokens (e.g. after a refresh) and updates the subscription type. */
  async updateCreds(id: string, creds: OAuthCreds): Promise<void> {
    const previous = await this.getCreds(id);
    await this.setCreds(id, creds);
    const profiles = this.profiles;
    const p = profiles.find((x) => x.id === id);
    let changed = false;
    if (p && creds.subscriptionType && p.subscriptionType !== creds.subscriptionType) {
      p.subscriptionType = creds.subscriptionType;
      changed = true;
    }
    if (p && credentialsChanged(previous, creds)) {
      if (p.lastUsage) {
        const next = { ...p.lastUsage };
        delete next.error;
        delete next.retryAfter;
        p.lastUsage = next;
      }
      if (p.deadRefreshTokenHash && p.deadRefreshTokenHash !== tokenFingerprint(creds.refreshToken)) {
        delete p.deadRefreshTokenHash;
      }
      changed = true;
    }
    if (changed) {
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

  /** Stores `candidate` only when it is a newer token generation than the vault copy. */
  async updateCredsIfNewer(id: string, candidate: OAuthCreds): Promise<boolean> {
    const stored = await this.getCreds(id);
    if (!stored || shouldPreferCredentialCandidate(candidate, stored)) {
      if (!stored || credentialsChanged(stored, candidate)) {
        await this.updateCreds(id, candidate);
        return true;
      }
    }
    return false;
  }
}

function credentialsChanged(previous: OAuthCreds | null, next: OAuthCreds): boolean {
  if (!previous) {
    return true;
  }
  return (
    !sameNonEmptyToken(previous.accessToken, next.accessToken) ||
    !sameNonEmptyToken(previous.refreshToken, next.refreshToken)
  );
}
