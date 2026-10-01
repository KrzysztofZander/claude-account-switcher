import { AccountProfile, ClaudeAuthIdentity } from "./types";

/**
 * Account identity helpers. A Claude subscription is an (account, organization)
 * pair: one person can belong to several organizations, and a Team organization
 * contains several people, so neither the org id nor the email alone is unique.
 */

export function profileIdentity(profile: AccountProfile): ClaudeAuthIdentity | undefined {
  const identity: ClaudeAuthIdentity = {
    accountUuid: normalizeIdentityValue(profile.authAccountUuid),
    email: normalizeIdentityValue(profile.authEmail),
    orgId: normalizeIdentityValue(profile.authOrgId),
    orgName: normalizeIdentityValue(profile.authOrgName),
  };
  return hasIdentity(identity) ? identity : undefined;
}

export function hasIdentity(identity: ClaudeAuthIdentity | undefined): boolean {
  return Boolean(
    normalizeIdentityValue(identity?.accountUuid) ||
      normalizeEmail(identity?.email) ||
      normalizeIdentityValue(identity?.orgId)
  );
}

/**
 * True when both identities describe the same subscription. Any key known on both
 * sides must agree; at least one person-level key (account uuid or email) must
 * match, except for legacy profiles that only ever recorded an organization id.
 */
export function sameIdentity(a: ClaudeAuthIdentity, b: ClaudeAuthIdentity): boolean {
  const account = compare(a.accountUuid, b.accountUuid);
  const email = compare(normalizeEmail(a.email), normalizeEmail(b.email));
  const org = compare(a.orgId, b.orgId);
  if (account === false || email === false || org === false) {
    return false;
  }
  if (account === true || email === true) {
    return true;
  }
  const personKnown =
    Boolean(normalizeIdentityValue(a.accountUuid) || normalizeEmail(a.email)) &&
    Boolean(normalizeIdentityValue(b.accountUuid) || normalizeEmail(b.email));
  return org === true && !personKnown;
}

export function profileMatchesIdentity(
  profile: AccountProfile,
  identity: ClaudeAuthIdentity
): boolean {
  const saved = profileIdentity(profile);
  return saved ? sameIdentity(saved, identity) : false;
}

export function identityLabel(identity: ClaudeAuthIdentity): string {
  return (
    identity.email ?? identity.orgName ?? identity.accountUuid ?? identity.orgId ?? "unknown account"
  );
}

export function normalizeEmail(value: string | undefined): string | undefined {
  return normalizeIdentityValue(value)?.toLowerCase();
}

export function normalizeIdentityValue(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  return trimmed ? trimmed : undefined;
}

function compare(a: string | undefined, b: string | undefined): boolean | undefined {
  const left = normalizeIdentityValue(a);
  const right = normalizeIdentityValue(b);
  if (!left || !right) {
    return undefined;
  }
  return left === right;
}
