import { AccountStore } from "./accountStore";
import { readClaudeAuthStatus } from "./authStatus";
import { sameDir, withClaudeConfigLocks } from "./claudeLock";
import {
  hasUsableOAuthCreds,
  sameNonEmptyToken,
  shouldPreferCredentialCandidate,
} from "./credentialValidation";
import { CredentialsManager } from "./credentials";
import { hasIdentity, profileIdentity, sameIdentity } from "./identity";
import { fetchOAuthIdentity, TokenRefresher, tokenFingerprint } from "./oauth";
import { ClaudeAuthIdentity, OAuthCreds } from "./types";

const LOCK_TIMEOUT_MS = 15_000;
const FAILED_IDENTITY_RETRY_MS = 10 * 60_000;

export interface FreshCredsResult {
  ok: boolean;
  creds?: OAuthCreds;
  error?: string;
  /** Another process (usually Claude Code) holds the refresh lock; try again later. */
  deferred?: boolean;
  /** Every known token generation of this profile was rejected by the server. */
  needsReauthorization?: boolean;
}

export interface FileOwner {
  creds?: OAuthCreds;
  /** Saved profile the file belongs to (by token or verified account identity). */
  ownerId?: string;
  /** Account identity of the file, when it had to be looked up. */
  identity?: ClaudeAuthIdentity;
  /** True when the owner (or the absence of one) was positively established. */
  verified: boolean;
}

export interface CurrentAccountState {
  ownerId?: string;
  /** A logged-in account that is not saved as a profile yet. */
  unsavedIdentity?: ClaudeAuthIdentity;
}

/**
 * Keeps every copy of a profile's rotating OAuth tokens consistent.
 *
 * A login can live in several places at once: the extension's SecretStorage vault,
 * the Claude Code credentials file the user is running on (`~/.claude`), and the
 * profile's isolated `CLAUDE_CONFIG_DIR` used by independent windows and Say Hi.
 * Refresh tokens are single-use, so this class:
 *  - always picks the newest generation across all copies before using one;
 *  - refreshes only while holding Claude Code's own refresh locks for every
 *    directory that holds the login, and writes the result back to each of them
 *    (compare-and-swap), exactly like a second Claude Code process would;
 *  - never sends a refresh token the server has already rejected.
 */
export class CredentialSync {
  private readonly identityCache = new Map<
    string,
    { identity?: ClaudeAuthIdentity; checkedAt: number }
  >();

  constructor(
    private readonly store: AccountStore,
    private readonly credentials: CredentialsManager,
    private readonly refresher: TokenRefresher,
    private readonly homeDir: (id: string) => string,
    private readonly lookupIdentity: (
      creds: OAuthCreds,
      configDir?: string
    ) => Promise<ClaudeAuthIdentity | undefined> = defaultIdentityLookup
  ) {}

  /** Looks up (and caches per access token) the account behind a credential set. */
  async identify(creds: OAuthCreds, configDir?: string): Promise<ClaudeAuthIdentity | undefined> {
    const key = tokenFingerprint(creds.accessToken);
    const cached = this.identityCache.get(key);
    if (cached?.identity) {
      return cached.identity;
    }
    if (cached && Date.now() - cached.checkedAt < FAILED_IDENTITY_RETRY_MS) {
      return undefined;
    }
    const identity = await this.lookupIdentity(creds, configDir);
    this.identityCache.set(key, {
      identity: hasIdentity(identity) ? identity : undefined,
      checkedAt: Date.now(),
    });
    return hasIdentity(identity) ? identity : undefined;
  }

  rememberIdentity(creds: OAuthCreds, identity: ClaudeAuthIdentity | undefined): void {
    if (hasIdentity(identity)) {
      this.identityCache.set(tokenFingerprint(creds.accessToken), {
        identity,
        checkedAt: Date.now(),
      });
    }
  }

  /** Determines which saved profile a credentials file belongs to. */
  async resolveFileOwner(configDir: string): Promise<FileOwner> {
    const creds = this.credentials.readCurrent(configDir);
    if (!creds || !hasUsableOAuthCreds(creds)) {
      return { verified: false };
    }
    const byTokens = await this.store.findByTokens(creds);
    if (byTokens) {
      return { creds, ownerId: byTokens, verified: true };
    }
    const identity = await this.identify(creds, configDir);
    if (!identity) {
      return { creds, verified: false };
    }
    const owner = this.store.findByIdentity(identity);
    if (owner) {
      return { creds, identity, ownerId: owner.id, verified: true };
    }
    // An identified account that no profile claims. Profiles saved before identities
    // were recorded cannot be ruled out, so the result is only verified without them.
    const unidentified = this.store.list().some((p) => !profileIdentity(p));
    return { creds, identity, verified: !unidentified };
  }

  /**
   * Reconciles the credentials file this window's Claude Code uses with the vault:
   * finds its owner, imports a newer token generation, records identity details and
   * Claude Code's `oauthAccount` snapshot for later switches.
   */
  async syncCurrent(): Promise<CurrentAccountState> {
    const configDir = this.credentials.getConfigDir();
    const owner = await this.resolveFileOwner(configDir);
    if (!owner.creds) {
      return { ownerId: this.store.getActiveId() };
    }

    if (!owner.ownerId) {
      if (owner.verified) {
        await this.store.setActiveId(undefined);
        return { unsavedIdentity: owner.identity };
      }
      // Unknown owner (offline, expired token, no CLI): keep the remembered marker
      // but never import tokens that might belong to another account.
      return { ownerId: this.store.getActiveId() };
    }

    const id = owner.ownerId;
    await this.store.setActiveId(id);
    await this.store.updateCredsIfNewer(id, owner.creds);
    const identity = owner.identity ?? (await this.identify(owner.creds, configDir));
    if (identity) {
      const profile = this.store.get(id);
      if (profile && (!profileIdentity(profile) || sameIdentity(profileIdentity(profile)!, identity))) {
        await this.store.updateIdentity(id, identity);
      }
    }
    await this.captureOAuthAccount(id, configDir);
    return { ownerId: id };
  }

  /** Saves Claude Code's `oauthAccount` for a profile when it describes that account. */
  async captureOAuthAccount(id: string, configDir: string): Promise<void> {
    const account = this.credentials.readOAuthAccount(configDir);
    const profile = this.store.get(id);
    const saved = profile ? profileIdentity(profile) : undefined;
    if (!account || !saved) {
      return;
    }
    const accountIdentity: ClaudeAuthIdentity = {
      accountUuid: stringValue(account.accountUuid),
      email: stringValue(account.emailAddress),
      orgId: stringValue(account.organizationUuid),
    };
    if (hasIdentity(accountIdentity) && sameIdentity(saved, accountIdentity)) {
      await this.store.setOAuthAccount(id, account);
    }
  }

  /** Config directories (besides the vault) currently holding this profile's login. */
  async replicaDirs(id: string): Promise<string[]> {
    const home = this.homeDir(id);
    const dirs = [home];
    for (const dir of [this.credentials.getConfigDir(), this.credentials.getGlobalConfigDir()]) {
      if (dirs.some((known) => sameDir(known, dir))) {
        continue;
      }
      const owner = await this.resolveFileOwner(dir);
      if (owner.ownerId === id) {
        dirs.push(dir);
      }
    }
    return dirs;
  }

  /**
   * Returns a usable access token for the profile, refreshing it only when needed
   * and only under Claude Code's locks. `rejectedAccessToken` forces a refresh
   * unless another process already replaced that token.
   */
  async getFreshCreds(
    id: string,
    options: { rejectedAccessToken?: string } = {}
  ): Promise<FreshCredsResult> {
    if (!(await this.store.getCreds(id))) {
      return { ok: false, needsReauthorization: true, error: "No stored credentials." };
    }
    const dirs = await this.replicaDirs(id);

    const locked = await withClaudeConfigLocks(dirs, LOCK_TIMEOUT_MS, async () => {
      const newest = await this.collectNewest(id, dirs);
      if (!newest) {
        return {
          ok: false,
          needsReauthorization: true,
          error:
            "Refresh token not found or invalid (invalid_grant). Reauthorize this account profile.",
        } satisfies FreshCredsResult;
      }

      const rejected = options.rejectedAccessToken;
      if (rejected ? newest.accessToken !== rejected : !TokenRefresher.isExpired(newest)) {
        return { ok: true, creds: newest } satisfies FreshCredsResult;
      }

      const refreshed = await this.refresher.refresh(newest);
      if (!refreshed.ok || !refreshed.creds) {
        if (refreshed.requiresReauthorization) {
          await this.store.markRefreshTokenDead(id, newest.refreshToken);
          return {
            ok: false,
            needsReauthorization: true,
            error: refreshed.error ?? "invalid_grant",
          } satisfies FreshCredsResult;
        }
        return {
          ok: false,
          error: "Failed to refresh token: " + (refreshed.error ?? "error"),
        } satisfies FreshCredsResult;
      }

      await this.store.updateCreds(id, refreshed.creds);
      for (const dir of dirs) {
        try {
          this.credentials.writeCredsIfCurrent(newest, refreshed.creds, dir);
        } catch {
          /* the vault keeps the new generation; Claude Code re-reads under the lock */
        }
      }
      if (refreshed.identity) {
        this.rememberIdentity(refreshed.creds, refreshed.identity);
        const profile = this.store.get(id);
        const saved = profile ? profileIdentity(profile) : undefined;
        if (!saved || sameIdentity(saved, refreshed.identity)) {
          await this.store.updateIdentity(id, refreshed.identity);
        }
      }
      return { ok: true, creds: refreshed.creds } satisfies FreshCredsResult;
    });

    if (!locked.acquired) {
      return { ok: false, deferred: true };
    }
    return locked.value ?? { ok: false, error: "Failed to read credentials." };
  }

  /**
   * Writes the newest generation of an inactive profile into its isolated config dir
   * before Claude Code runs there (independent window, Say Hi). The lock is released
   * before returning so Claude Code can take it for its own refreshes.
   */
  async prepareHomeDir(id: string): Promise<FreshCredsResult> {
    const home = this.homeDir(id);
    const dirs = await this.replicaDirs(id);
    const locked = await withClaudeConfigLocks(dirs, LOCK_TIMEOUT_MS, async () => {
      const newest = await this.collectNewest(id, dirs);
      if (!newest) {
        return { ok: false, needsReauthorization: true } satisfies FreshCredsResult;
      }
      const inHome = this.credentials.readCurrent(home);
      if (!inHome || !sameGeneration(inHome, newest)) {
        this.credentials.writeCreds(newest, home, {
          organizationUuid: this.store.get(id)?.authOrgId ?? null,
        });
      }
      return { ok: true, creds: newest } satisfies FreshCredsResult;
    });
    if (!locked.acquired) {
      return { ok: false, deferred: true };
    }
    return locked.value ?? { ok: false };
  }

  /**
   * Makes `id` the login of `configDir` (an account switch). Under Claude Code's
   * lock it first saves the outgoing login's latest rotation into its own profile,
   * then writes the newest generation of the target, its organization and Claude
   * Code's cached `oauthAccount`, so nothing is left holding a spent token.
   */
  async installInConfigDir(
    id: string,
    configDir: string,
    outgoingId: string | undefined
  ): Promise<{ ok: boolean; message?: string; deferred?: boolean; needsReauthorization?: boolean }> {
    const targetDirs = await this.replicaDirs(id);
    const locked = await withClaudeConfigLocks(
      [configDir, ...targetDirs],
      LOCK_TIMEOUT_MS,
      async () => {
        const current = this.credentials.readCurrent(configDir);
        if (outgoingId && outgoingId !== id && current && hasUsableOAuthCreds(current)) {
          await this.store.updateCredsIfNewer(outgoingId, current);
        }

        const target = await this.collectNewest(id, targetDirs);
        if (!target) {
          return { ok: false, needsReauthorization: true };
        }
        this.credentials.backupCurrent();
        this.credentials.writeCreds(target, configDir, {
          organizationUuid: this.store.get(id)?.authOrgId ?? null,
        });
        const account = this.store.get(id)?.oauthAccount;
        if (account) {
          this.credentials.writeOAuthAccount(account, configDir);
        }
        await this.store.setActiveId(id);
        return { ok: true };
      }
    );
    if (!locked.acquired) {
      return {
        ok: false,
        deferred: true,
        message: "Claude Code is refreshing its login right now. Try again in a few seconds.",
      };
    }
    return locked.value ?? { ok: false };
  }

  /** Imports whatever Claude Code left in the profile's isolated config dir. */
  async importHomeDir(id: string): Promise<void> {
    const creds = this.credentials.readCurrent(this.homeDir(id));
    if (creds && hasUsableOAuthCreds(creds) && !this.store.isRefreshTokenDead(id, creds.refreshToken)) {
      await this.store.updateCredsIfNewer(id, creds);
    }
  }

  /** Newest usable, not-known-dead generation across the vault and the given dirs. */
  async newestCreds(id: string): Promise<OAuthCreds | undefined> {
    return this.collectNewest(id, await this.replicaDirs(id));
  }

  private async collectNewest(id: string, dirs: string[]): Promise<OAuthCreds | undefined> {
    const candidates: OAuthCreds[] = [];
    const vault = await this.store.getCreds(id);
    if (vault) {
      candidates.push(vault);
    }
    for (const dir of dirs) {
      const fileCreds = this.credentials.readCurrent(dir);
      if (fileCreds) {
        candidates.push(fileCreds);
      }
    }

    let newest: OAuthCreds | undefined;
    for (const candidate of candidates) {
      if (!hasUsableOAuthCreds(candidate) || this.store.isRefreshTokenDead(id, candidate.refreshToken)) {
        continue;
      }
      if (!newest || shouldPreferCredentialCandidate(candidate, newest)) {
        newest = candidate;
      }
    }
    if (newest) {
      await this.store.updateCredsIfNewer(id, newest);
    }
    return newest;
  }
}

async function defaultIdentityLookup(
  creds: OAuthCreds,
  configDir?: string
): Promise<ClaudeAuthIdentity | undefined> {
  if (!TokenRefresher.isExpired(creds)) {
    const identity = await fetchOAuthIdentity(creds.accessToken);
    if (identity) {
      return identity;
    }
  }
  if (!configDir) {
    return undefined;
  }
  // Fallback through the CLI; it refreshes an expired token under Claude Code's lock.
  const status = await readClaudeAuthStatus(configDir);
  return status.ok && status.status?.loggedIn ? status.status : undefined;
}

function sameGeneration(a: OAuthCreds, b: OAuthCreds): boolean {
  return (
    sameNonEmptyToken(a.accessToken, b.accessToken) &&
    sameNonEmptyToken(a.refreshToken, b.refreshToken)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
