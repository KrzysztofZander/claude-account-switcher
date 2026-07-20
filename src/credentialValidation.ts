import { OAuthCreds } from "./types";

export function hasAccessToken(creds: Partial<OAuthCreds> | null | undefined): boolean {
  return isNonEmptyString(creds?.accessToken);
}

export function hasRefreshToken(creds: Partial<OAuthCreds> | null | undefined): boolean {
  return isNonEmptyString(creds?.refreshToken);
}

export function hasUsableOAuthCreds(creds: Partial<OAuthCreds> | null | undefined): boolean {
  return hasAccessToken(creds) && hasRefreshToken(creds);
}

export function sameNonEmptyToken(a: unknown, b: unknown): boolean {
  return isNonEmptyString(a) && a === b;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
