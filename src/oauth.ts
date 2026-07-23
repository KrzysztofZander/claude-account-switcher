import { OAuthCreds } from "./types";

/**
 * Refreshes the Claude Code access token using the refresh token.
 *
 * NOTE: the endpoint and client_id are well-known public values of the Claude Code
 * client (the OAuth flow is not officially documented). They may change. The refresh
 * token is single-use (it rotates) — the caller MUST persist the returned new refresh
 * token back to the profile.
 */
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_AI_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const OAUTH_BETA = "oauth-2025-04-20";
export const CLAUDE_CODE_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
const DEFAULT_REFRESH_SCOPES = CLAUDE_CODE_SCOPES.filter(
  (scope) => scope !== "org:create_api_key"
);

export interface RefreshResult {
  ok: boolean;
  creds?: OAuthCreds;
  error?: string;
  status?: number;
  requiresReauthorization?: boolean;
}

export class TokenRefresher {
  async refresh(creds: OAuthCreds): Promise<RefreshResult> {
    try {
      if (!isNonEmptyString(creds.refreshToken)) {
        return {
          ok: false,
          requiresReauthorization: true,
          error:
            "Stored profile has no refresh token. Reauthorize this account profile.",
        };
      }

      const payload: Record<string, string> = {
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: creds.clientId ?? OAUTH_CLIENT_ID,
        scope: normalizeScopes(creds.scopes).join(" "),
      };

      const res = await fetch(OAUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "anthropic-beta": OAUTH_BETA,
          "User-Agent": "claude-code-account-switcher",
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const oauthError = parseOAuthError(body);
        if (isInvalidGrant(res.status, oauthError, body)) {
          return {
            ok: false,
            status: res.status,
            requiresReauthorization: true,
            error: formatInvalidGrantError(res.status, oauthError),
          };
        }

        const sentFields = Object.keys(payload).join(", ");
        return {
          ok: false,
          status: res.status,
          error: `HTTP ${res.status} from token endpoint (sent fields: ${sentFields}): ${body.slice(0, 200)}`,
        };
      }

      const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        refresh_token_expires_in?: number;
        expires_in?: number;
        scope?: string;
      };

      if (!data.access_token) {
        return { ok: false, error: "No access_token in response" };
      }

      const next: OAuthCreds = {
        ...creds,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? creds.refreshToken,
        refreshTokenExpiresAt: data.refresh_token_expires_in
          ? Date.now() + data.refresh_token_expires_in * 1000
          : creds.refreshTokenExpiresAt,
        expiresAt: data.expires_in
          ? Date.now() + data.expires_in * 1000
          : creds.expiresAt,
        scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : creds.scopes,
      };
      return { ok: true, creds: next };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Whether the token has expired (with a 60s safety margin). */
  static isExpired(creds: OAuthCreds): boolean {
    return typeof creds.expiresAt === "number" && creds.expiresAt - 60_000 < Date.now();
  }
}

function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) {
    return DEFAULT_REFRESH_SCOPES;
  }
  const normalized = scopes.filter(isNonEmptyString);
  return normalized.length > 0 ? normalized : DEFAULT_REFRESH_SCOPES;
}

export function requiresProfileReauthorization(error: string | undefined): boolean {
  const text = error?.toLowerCase() ?? "";
  return (
    text.includes("invalid_grant") ||
    text.includes("refresh token not found or invalid") ||
    text.includes("stored profile has no refresh token") ||
    text.includes("reauthorize this account profile")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseOAuthError(body: string): { error?: string; error_description?: string } | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      error_description?: unknown;
    };
    return {
      error: typeof parsed.error === "string" ? parsed.error : undefined,
      error_description:
        typeof parsed.error_description === "string" ? parsed.error_description : undefined,
    };
  } catch {
    return null;
  }
}

function isInvalidGrant(
  status: number,
  oauthError: { error?: string } | null,
  body: string
): boolean {
  return (
    status === 400 &&
    (oauthError?.error === "invalid_grant" || body.toLowerCase().includes("invalid_grant"))
  );
}

function formatInvalidGrantError(
  status: number,
  oauthError: { error_description?: string } | null
): string {
  const detail = stripTrailingPunctuation(
    oauthError?.error_description ?? "Refresh token is invalid or expired"
  );
  return `HTTP ${status} invalid_grant: ${detail}. Reauthorize this account profile.`;
}

function stripTrailingPunctuation(value: string): string {
  return value.trim().replace(/[.!?]+$/, "");
}
