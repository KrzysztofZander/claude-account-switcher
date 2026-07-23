import * as crypto from "crypto";
import * as http from "http";
import {
  CLAUDE_AI_AUTHORIZE_URL,
  CLAUDE_CODE_SCOPES,
  OAUTH_CLIENT_ID,
  OAUTH_TOKEN_URL,
} from "./oauth";
import { ClaudeAuthIdentity, OAuthCreds } from "./types";

const CALLBACK_TIMEOUT_MS = 10 * 60_000;

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  refresh_token_expires_in?: unknown;
  scope?: unknown;
  account?: { email_address?: unknown };
  organization?: { uuid?: unknown; name?: unknown };
}

export interface BrowserAuthorizationResult {
  ok: boolean;
  creds?: OAuthCreds;
  identity?: ClaudeAuthIdentity;
  error?: string;
}

/** Browser OAuth login used when the local Claude Code CLI is unavailable. */
export class BrowserOAuthLogin {
  async authorize(openBrowser: (url: string) => Thenable<boolean>): Promise<BrowserAuthorizationResult> {
    let callback: Awaited<ReturnType<typeof createCallbackServer>> | undefined;
    try {
      const verifier = createCodeVerifier();
      const state = randomUrlSafe(32);
      callback = await createCallbackServer(state);
      const url = buildBrowserAuthorizationUrl(callback.port, state, verifier.challenge);
      const opened = await openBrowser(url);
      if (!opened) {
        return { ok: false, error: "Could not open the browser for Claude authorization." };
      }

      const code = await callback.waitForCode();
      const tokenResponse = await exchangeAuthorizationCode(code, state, verifier.value, callback.port);
      const parsed = parseBrowserTokenResponse(tokenResponse);
      if (!parsed.creds) {
        return { ok: false, error: "Authorization succeeded but no OAuth tokens were returned." };
      }
      return { ok: true, creds: parsed.creds, identity: parsed.identity };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      callback?.close();
    }
  }
}

export function buildBrowserAuthorizationUrl(
  port: number,
  state: string,
  codeChallenge: string
): string {
  const url = new URL(CLAUDE_AI_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", callbackUrl(port));
  url.searchParams.set("scope", CLAUDE_CODE_SCOPES.join(" "));
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

export function parseBrowserTokenResponse(data: TokenResponse): {
  creds?: OAuthCreds;
  identity?: ClaudeAuthIdentity;
} {
  if (!nonEmpty(data.access_token) || !nonEmpty(data.refresh_token)) {
    return {};
  }

  const now = Date.now();
  const creds: OAuthCreds = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: numberOr(data.expires_in) ? now + numberOr(data.expires_in)! * 1000 : now,
    refreshTokenExpiresAt: numberOr(data.refresh_token_expires_in)
      ? now + numberOr(data.refresh_token_expires_in)! * 1000
      : undefined,
    scopes: nonEmpty(data.scope)
      ? data.scope.split(/\s+/).filter(Boolean)
      : [...CLAUDE_CODE_SCOPES],
    clientId: OAUTH_CLIENT_ID,
  };
  const identity: ClaudeAuthIdentity = {
    email: stringOr(data.account?.email_address),
    orgId: stringOr(data.organization?.uuid),
    orgName: stringOr(data.organization?.name),
  };
  return { creds, identity: identity.email || identity.orgId ? identity : undefined };
}

async function exchangeAuthorizationCode(
  code: string,
  state: string,
  codeVerifier: string,
  port: number
): Promise<TokenResponse> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code-account-switcher",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(port),
      client_id: OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
      state,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Token exchange failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
  }
  return (await response.json()) as TokenResponse;
}

function createCallbackServer(expectedState: string): Promise<{
  port: number;
  waitForCode: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    let settleCode: ((value: string) => void) | undefined;
    let settleError: ((reason: Error) => void) | undefined;
    const codePromise = new Promise<string>((resolveCode, rejectCode) => {
      settleCode = resolveCode;
      settleError = rejectCode;
    });
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== "/callback") {
        response.writeHead(404).end();
        return;
      }
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (state !== expectedState) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h2>Authorization failed: invalid state.</h2>");
        settleError?.(new Error("Authorization callback state did not match."));
        return;
      }
      if (error || !code) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end("<h2>Authorization was cancelled or denied.</h2>");
        settleError?.(new Error(error ?? "Authorization callback did not contain a code."));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<h2>Authorization complete.</h2><p>You can return to VS Code.</p>");
      settleCode?.(code);
    });
    const timeout = setTimeout(() => {
      settleError?.(new Error("Browser authorization timed out after 10 minutes."));
    }, CALLBACK_TIMEOUT_MS);
    server.once("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        clearTimeout(timeout);
        server.close();
        reject(new Error("Could not reserve a local OAuth callback port."));
        return;
      }
      resolve({
        port: address.port,
        waitForCode: () =>
          codePromise.finally(() => {
            clearTimeout(timeout);
          }),
        close: () => {
          clearTimeout(timeout);
          server.close();
        },
      });
    });
  });
}

function createCodeVerifier(): { value: string; challenge: string } {
  const value = randomUrlSafe(64);
  const challenge = crypto.createHash("sha256").update(value).digest("base64url");
  return { value, challenge };
}

function callbackUrl(port: number): string {
  // Bind and redirect to the same IP family. Some systems resolve localhost to
  // IPv6 first, while the listener deliberately accepts loopback IPv4 only.
  return `http://127.0.0.1:${port}/callback`;
}

function randomUrlSafe(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringOr(value: unknown): string | undefined {
  return nonEmpty(value) ? value : undefined;
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
