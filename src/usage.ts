import { AccountStore } from "./accountStore";
import { CredentialsManager } from "./credentials";
import { withFileLock } from "./lock";
import { TokenRefresher } from "./oauth";
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
    private readonly onUpdate: () => void
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
    await this.store.syncActiveFromFile(this.credentials.readCurrent());

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
    const prev = profile.lastUsage;
    if (!force && prev?.retryAfter && prev.retryAfter > Date.now()) {
      return;
    }

    let creds = await this.store.getCreds(id);
    if (!creds) {
      return;
    }

    // Refresh an expired token (it rotates, so save the new one).
    if (TokenRefresher.isExpired(creds)) {
      const refreshed = await this.refreshCreds(id, creds, false, prev);
      if (!refreshed) {
        return;
      }
      creds = refreshed;
    }

    let result = await fetchUsage(creds);
    if (result.status === 401 || result.status === 403) {
      const refreshed = await this.refreshCreds(id, creds, true, prev);
      if (refreshed) {
        creds = refreshed;
        result = await fetchUsage(creds);
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
      const latest = (await this.store.getCreds(id)) ?? credsBeforeLock;

      if (!force && !TokenRefresher.isExpired(latest)) {
        return { ok: true as const, creds: latest };
      }

      if (force && latest.accessToken !== credsBeforeLock.accessToken) {
        return { ok: true as const, creds: latest };
      }

      const refreshed = await this.refresher.refresh(latest);
      if (!refreshed.ok || !refreshed.creds) {
        return {
          ok: false as const,
          error: "Failed to refresh token: " + (refreshed.error ?? "error"),
        };
      }

      await this.store.updateCreds(id, refreshed.creds);
      if (this.store.getActiveId() === id) {
        try {
          this.credentials.writeCreds(refreshed.creds);
        } catch {
          /* best effort: Claude Code can still use the stored profile on next switch */
        }
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
}
