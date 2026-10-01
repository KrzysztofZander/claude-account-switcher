import { AccountStore } from "./accountStore";
import { CredentialSync } from "./credentialSync";
import { profileIdentity, sameIdentity } from "./identity";
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
 * Periodically polls usage limits for all accounts. Tokens come from CredentialSync,
 * which refreshes them only under Claude Code's own locks and writes every rotation
 * back to all local copies, so polling never strands Claude Code with a spent token.
 * Respects a per-account backoff (on 429) and a hard 180s minimum interval.
 */
export class UsagePoller {
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;

  constructor(
    private readonly store: AccountStore,
    private readonly sync: CredentialSync,
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

  pollAll(force: boolean): Promise<void> {
    if (this.polling) {
      return this.polling;
    }
    this.polling = this.runPollAll(force).finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async runPollAll(force: boolean): Promise<void> {
    try {
      await this.sync.syncCurrent();
    } catch {
      /* polling still works from the vault */
    }
    for (const profile of this.store.list()) {
      try {
        await this.pollOne(profile.id, force);
      } catch {
        /* one broken profile must not stop the others */
      }
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

    let fresh = await this.sync.getFreshCreds(id);
    if (!fresh.ok || !fresh.creds) {
      if (!fresh.deferred) {
        await this.recordError(id, fresh.error ?? "Failed to read credentials.");
      }
      return;
    }

    let result = await fetchUsage(fresh.creds);
    if (result.status === 401 || result.status === 403) {
      fresh = await this.sync.getFreshCreds(id, { rejectedAccessToken: fresh.creds.accessToken });
      if (!fresh.ok || !fresh.creds) {
        if (!fresh.deferred) {
          await this.recordError(id, fresh.error ?? result.error ?? "Unauthorized");
        }
        return;
      }
      result = await fetchUsage(fresh.creds);
    }

    if (result.snapshot) {
      await this.store.updateUsage(id, result.snapshot);
      if (!this.store.get(id)?.authAccountUuid) {
        const identity = await this.sync.identify(fresh.creds);
        const saved = this.store.get(id);
        if (identity && saved && (!profileIdentity(saved) || sameIdentity(profileIdentity(saved)!, identity))) {
          await this.store.updateIdentity(id, identity);
        }
      }
    } else {
      await this.recordError(id, result.error ?? "Failed to fetch usage", result.retryAfter);
    }
  }

  private async recordError(id: string, error: string, retryAfter?: number): Promise<void> {
    const prev = this.store.get(id)?.lastUsage;
    await this.store.updateUsage(id, {
      fetchedAt: Date.now(),
      windows: prev?.windows ?? [],
      sessionPercent: prev?.sessionPercent ?? null,
      weeklyPercent: prev?.weeklyPercent ?? null,
      error,
      retryAfter,
    });
  }
}
