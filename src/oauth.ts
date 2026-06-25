import { OAuthCreds } from "./types";

/**
 * Refreshes the Claude Code access token using the refresh token.
 *
 * NOTE: the endpoint and client_id are well-known public values of the Claude Code
 * client (the OAuth flow is not officially documented). They may change. The refresh
 * token is single-use (it rotates) — the caller MUST persist the returned new refresh
 * token back to the profile.
 */
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface RefreshResult {
  ok: boolean;
  creds?: OAuthCreds;
  error?: string;
  status?: number;
}

export class TokenRefresher {
  async refresh(creds: OAuthCreds): Promise<RefreshResult> {
    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: creds.refreshToken,
          client_id: CLIENT_ID,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          ok: false,
          status: res.status,
          error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
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
        expiresAt: data.expires_in
          ? Date.now() + data.expires_in * 1000
          : creds.expiresAt,
        scopes: data.scope ? data.scope.split(/\s+/) : creds.scopes,
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
