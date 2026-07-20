/**
 * Raw structure stored in ~/.claude/.credentials.json
 * { "claudeAiOauth": { ... } }
 */
export interface OAuthCreds {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the accessToken expires */
  expiresAt: number;
  /** epoch ms when the refreshToken expires */
  refreshTokenExpiresAt?: number;
  scopes: string[];
  clientId?: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface ClaudeAuthIdentity {
  email?: string;
  orgId?: string;
  orgName?: string;
}

export interface CredentialsFile {
  claudeAiOauth: OAuthCreds;
  [key: string]: unknown;
}

/** Profile metadata (no secrets) — kept in globalState. */
export interface AccountProfile {
  id: string;
  label: string;
  subscriptionType?: string;
  authEmail?: string;
  authOrgId?: string;
  authOrgName?: string;
  addedAt: number;
  order: number;
  /** last read usage snapshot (cached for fast rendering) */
  lastUsage?: UsageSnapshot;
}

/** A single usage window (5h / weekly / opus, etc.) normalized for the UI. */
export interface UsageWindow {
  kind: string;
  label: string;
  /** 0-100 */
  percent: number;
  severity: string;
  resetsAt: string | null;
}

export interface UsageSnapshot {
  fetchedAt: number;
  windows: UsageWindow[];
  /** convenience shortcuts for the UI */
  sessionPercent: number | null;
  weeklyPercent: number | null;
  /** set when the request failed */
  error?: string;
  /** earliest time a retry is allowed (epoch ms) — backoff on 429 */
  retryAfter?: number;
}

/** A profile together with its decrypted secrets (for internal operations). */
export interface AccountWithCreds {
  profile: AccountProfile;
  creds: OAuthCreds;
  isActive: boolean;
}
