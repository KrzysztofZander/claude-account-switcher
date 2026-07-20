import { OAuthCreds } from "./types";

/**
 * Refreshes the Claude Code access token using the refresh token.
 *
 * NOTE: the endpoint and client_id are well-known public values of the Claude Code
 * client (the OAuth flow is not officially documented). They may change. The refresh
 * token is single-use (it rotates) — the caller MUST persist the returned new refresh
 * token back to the profile.
 */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_BETA = "oauth-2025-04-20";
const DEFAULT_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

export interface RefreshResult {
  ok: boolean;
  creds?: OAuthCreds;
  error?: string;
  status?: number;
}

export class TokenRefresher {
  async refresh(creds: OAuthCreds): Promise<RefreshResult> {
    try {
      if (!isNonEmptyString(creds.refreshToken)) {
        return {
          ok: false,
          error:
            "Stored profile has no refresh token. Reauthorize this account profile.",
        };
      }

      const payload: Record<string, string> = {
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: creds.clientId ?? CLIENT_ID,
        scope: normalizeScopes(creds.scopes).join(" "),
      };

      const res = await fetch(TOKEN_URL, {
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
    return DEFAULT_SCOPES;
  }
  const normalized = scopes.filter(isNonEmptyString);
  return normalized.length > 0 ? normalized : DEFAULT_SCOPES;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
