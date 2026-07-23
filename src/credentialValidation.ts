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

/**
 * Decides whether a credential replica is a newer generation than the stored one.
 * Access-token expiry is compared first: refresh-token expiry is often an unchanged
 * absolute date and must not hide a later access-token rotation.
 */
export function shouldPreferCredentialCandidate(
  candidate: OAuthCreds,
  stored: OAuthCreds
): boolean {
  if (!hasUsableOAuthCreds(candidate)) {
    return false;
  }
  if (!hasUsableOAuthCreds(stored)) {
    return true;
  }
  if (
    sameNonEmptyToken(candidate.accessToken, stored.accessToken) &&
    sameNonEmptyToken(candidate.refreshToken, stored.refreshToken)
  ) {
    return true;
  }

  const candidateAccessExpiry = timestamp(candidate.expiresAt);
  const storedAccessExpiry = timestamp(stored.expiresAt);
  if (candidateAccessExpiry !== storedAccessExpiry) {
    return candidateAccessExpiry > storedAccessExpiry;
  }
  return (
    timestamp(candidate.refreshTokenExpiresAt) > timestamp(stored.refreshTokenExpiresAt)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
