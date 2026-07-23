import { AccountStore } from "./accountStore";
import {
  hasUsableOAuthCreds,
  sameNonEmptyToken,
  shouldPreferCredentialCandidate,
} from "./credentialValidation";
import { CredentialsManager } from "./credentials";
import { withFileLock } from "./lock";
import { requiresProfileReauthorization, TokenRefresher } from "./oauth";
import { OAuthCreds, UsageSnapshot, UsageWindow } from "./types";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USER_AGENT = "claude-code/2.0.14";
const BACKOFF_429_MS = 300_000; // 5 min after hitting the request rate limit

interface RawWindow {
  utilization?: number;
  resets_at?: string | null;
}
interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  is_active?: boolean;
}
interface RawUsage {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  limits?: RawLimit[];
}

function labelFor(kind: string, group: string): string {
  switch (kind) {
    case "session":
      return "Session (5h)";
    case "weekly_all":
      return "Weekly (all)";
    case "weekly_opus":
      return "Weekly (Opus)";
    case "weekly_sonnet":
      return "Weekly (Sonnet)";
    default:
      if (group === "session") return "Session (5h)";
      if (group === "weekly") return "Weekly";
      return kind || group || "Limit";
  }
}

/** Maps the raw endpoint response to a normalized snapshot. */
export function parseUsage(raw: RawUsage): UsageSnapshot {
  const windows: UsageWindow[] = [];

  if (Array.isArray(raw.limits) && raw.limits.length > 0) {
    for (const l of raw.limits) {
      const percent = typeof l.percent === "number" ? l.percent : 0;
      windows.push({
        kind: l.kind ?? l.group ?? "limit",
        label: labelFor(l.kind ?? "", l.group ?? ""),
        percent: Math.max(0, Math.min(100, Math.round(percent))),
        severity: l.severity ?? "normal",
        resetsAt: l.resets_at ?? null,
      });
    }
  } else {
    // Fall back to the five_hour / seven_day fields.
    if (raw.five_hour) {
      windows.push({
        kind: "session",
        label: "Session (5h)",
        percent: Math.round(raw.five_hour.utilization ?? 0),
        severity: "normal",
        resetsAt: raw.five_hour.resets_at ?? null,
      });
    }
    if (raw.seven_day) {
      windows.push({
        kind: "weekly_all",
        label: "Weekly (all)",
        percent: Math.round(raw.seven_day.utilization ?? 0),
        severity: "normal",
        resetsAt: raw.seven_day.resets_at ?? null,
      });
    }
  }

  const session = windows.find((w) => w.kind === "session");
  const weekly = windows.find((w) => w.kind === "weekly_all" || w.kind.startsWith("weekly"));

  return {
    fetchedAt: Date.now(),
    windows,
    sessionPercent: session ? session.percent : null,
    weeklyPercent: weekly ? weekly.percent : null,
  };
}

export interface FetchResult {
  snapshot?: UsageSnapshot;
  status: number;
  retryAfter?: number;
  error?: string;
}

export interface UsagePollerCoordination {
  /** Reads the persistent per-profile Claude config, if one exists. */
  readProfileCreds?: (id: string) => OAuthCreds | null;
  /** Reconciles the credentials file used by this VS Code window with SecretStorage. */
  syncCurrentProfile?: () => Promise<void>;
  /** True while Claude Code owns this profile in any live VS Code window. */
  isProfileActive?: (id: string) => boolean;
  /** Propagates a successful rotation to local credential replicas using compare-and-swap. */
  persistRefreshedCreds?: (
    id: string,
    previous: OAuthCreds,
    next: OAuthCreds
  ) => void;
}

/** A single call to the usage endpoint for the given token. */
export async function fetchUsage(creds: OAuthCreds): Promise<FetchResult> {
  try {
    const res = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + creds.accessToken,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });

    if (res.status === 429) {
      return { status: 429, retryAfter: Date.now() + BACKOFF_429_MS, error: "Rate limit (429)" };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { status: res.status, error: `HTTP ${res.status}: ${body.slice(0, 160)}` };
    }
    const data = (await res.json()) as RawUsage;
    return { status: 200, snapshot: parseUsage(data) };
  } catch (e) {
    return { status: 0, error: (e as Error).message };
  }
}

/**
 * Periodically polls usage limits for all accounts, refreshing expired tokens.
 * Respects a per-account backoff (on 429) and a hard 180s minimum interval.
 */
export class UsagePoller {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: AccountStore,
    private readonly refresher: TokenRefresher,
    private readonly credentials: CredentialsManager,
    private readonly getIntervalSeconds: () => number,
    private readonly onUpdate: () => void,
    private readonly coordination: UsagePollerCoordination = {}
  ) {}

  start(): void {
    this.stop();
    const intervalMs = Math.max(180, this.getIntervalSeconds()) * 1000;
    this.timer = setInterval(() => void this.pollAll(false), intervalMs);
    void this.pollAll(false);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Restart with the current interval (after a settings change). */
  restart(): void {
    this.start();
  }

  async pollAll(force: boolean): Promise<void> {
    // First sync the active profile from the file (fresh tokens).
    if (this.coordination.syncCurrentProfile) {
      await this.coordination.syncCurrentProfile();
    } else {
      await this.store.syncActiveFromFile(this.credentials.readCurrent());
    }

    const profiles = this.store.list();
    for (const profile of profiles) {
      await this.pollOne(profile.id, force);
    }
    this.onUpdate();
  }

  async pollOne(id: string, force: boolean): Promise<void> {
    const profile = this.store.get(id);
    if (!profile) {
      return;
    }

    // Backoff: if we recently got a 429, do not retry (unless forced).
    if (!force && profile.lastUsage?.retryAfter && profile.lastUsage.retryAfter > Date.now()) {
      return;
    }

    let creds = await this.store.getCreds(id);
    if (!creds) {
      return;
    }
    // Always reconcile the per-profile file before honoring a previous auth error.
    // Claude may have won a refresh race and persisted the valid rotated generation.
    creds = await this.syncProfileConfigCreds(id, creds);
    let prev = this.store.get(id)?.lastUsage;
    if (requiresProfileReauthorization(prev?.error) && this.isProfileActive(id)) {
      await this.syncActiveProfile();
      creds = (await this.store.getCreds(id)) ?? creds;
      prev = this.store.get(id)?.lastUsage;
    }
    if (requiresProfileReauthorization(prev?.error)) {
      return;
    }

    // Refresh an expired token (it rotates, so save the new one).
    if (TokenRefresher.isExpired(creds)) {
      if (this.isProfileActive(id)) {
        await this.syncActiveProfile();
        const synced = await this.store.getCreds(id);
        if (!synced || TokenRefresher.isExpired(synced)) {
          return;
        }
        creds = synced;
      }
    }

    if (TokenRefresher.isExpired(creds)) {
      const refreshed = await this.refreshCreds(id, creds, false, prev);
      if (!refreshed) {
        return;
      }
      creds = refreshed;
    }

    let result = await fetchUsage(creds);
    if (result.status === 401 || result.status === 403) {
      if (this.isProfileActive(id)) {
        await this.syncActiveProfile();
        const synced = await this.store.getCreds(id);
        if (!synced || !credentialsChanged(creds, synced)) {
          return;
        }
        creds = synced;
        result = await fetchUsage(creds);
      } else {
        const refreshed = await this.refreshCreds(id, creds, true, prev);
        if (refreshed) {
          creds = refreshed;
          result = await fetchUsage(creds);
        }
      }
    }

    if (result.snapshot) {
      await this.store.updateUsage(id, result.snapshot);
    } else {
      await this.store.updateUsage(id, {
        fetchedAt: Date.now(),
        windows: prev?.windows ?? [],
        sessionPercent: prev?.sessionPercent ?? null,
        weeklyPercent: prev?.weeklyPercent ?? null,
        error: result.error ?? "Failed to fetch usage",
        retryAfter: result.retryAfter,
      });
    }
  }

  private async refreshCreds(
    id: string,
    credsBeforeLock: OAuthCreds,
    force: boolean,
    prev: UsageSnapshot | undefined
  ): Promise<OAuthCreds | null> {
    const locked = await withFileLock(`refresh:${id}`, 10_000, async () => {
      const stored = (await this.store.getCreds(id)) ?? credsBeforeLock;
      const latest = await this.syncProfileConfigCreds(id, stored);

      if (this.isProfileActive(id)) {
        return { ok: false as const, deferred: true as const };
      }

      if (!force && !TokenRefresher.isExpired(latest)) {
        return { ok: true as const, creds: latest };
      }

      if (force && latest.accessToken !== credsBeforeLock.accessToken) {
        return { ok: true as const, creds: latest };
      }

      const refreshed = await this.refresher.refresh(latest);
      if (!refreshed.ok || !refreshed.creds) {
        const recovered = await this.syncProfileConfigCreds(id, latest);
        if (credentialsChanged(latest, recovered)) {
          return { ok: true as const, creds: recovered };
        }
        return {
          ok: false as const,
          error: "Failed to refresh token: " + (refreshed.error ?? "error"),
        };
      }

      await this.store.updateCreds(id, refreshed.creds);
      try {
        this.coordination.persistRefreshedCreds?.(id, latest, refreshed.creds);
      } catch {
        /* SecretStorage remains authoritative and stale replicas cannot replace it. */
      }
      return { ok: true as const, creds: refreshed.creds };
    });

    if (!locked.acquired) {
      await this.store.updateUsage(id, {
        fetchedAt: Date.now(),
        windows: prev?.windows ?? [],
        sessionPercent: prev?.sessionPercent ?? null,
        weeklyPercent: prev?.weeklyPercent ?? null,
        error: "Skipped token refresh because another VS Code window is refreshing it.",
      });
      return null;
    }

    if (!locked.value?.ok) {
      if (locked.value?.deferred) {
        return null;
      }
      await this.store.updateUsage(id, {
        fetchedAt: Date.now(),
        windows: prev?.windows ?? [],
        sessionPercent: prev?.sessionPercent ?? null,
        weeklyPercent: prev?.weeklyPercent ?? null,
        error: locked.value?.error ?? "Failed to refresh token.",
      });
      return null;
    }

    return locked.value.creds;
  }

  private async syncProfileConfigCreds(
    id: string,
    stored: OAuthCreds
  ): Promise<OAuthCreds> {
    const fileCreds = this.coordination.readProfileCreds?.(id);
    if (!fileCreds) {
      return stored;
    }

    if (!shouldPreferProfileFileCreds(fileCreds, stored)) {
      return stored;
    }

    await this.store.updateCreds(id, fileCreds);
    return fileCreds;
  }

  private isProfileActive(id: string): boolean {
    return this.store.getActiveId() === id || this.coordination.isProfileActive?.(id) === true;
  }

  private async syncActiveProfile(): Promise<void> {
    if (this.coordination.syncCurrentProfile) {
      await this.coordination.syncCurrentProfile();
    }
  }
}

function shouldPreferProfileFileCreds(fileCreds: OAuthCreds, stored: OAuthCreds): boolean {
  return (
    hasUsableOAuthCreds(stored) && shouldPreferCredentialCandidate(fileCreds, stored)
  );
}

function credentialsChanged(previous: OAuthCreds, next: OAuthCreds): boolean {
  return (
    !sameNonEmptyToken(previous.accessToken, next.accessToken) ||
    !sameNonEmptyToken(previous.refreshToken, next.refreshToken)
  );
}
