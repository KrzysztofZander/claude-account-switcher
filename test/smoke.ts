import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseUsage, UsagePoller } from "../src/usage";
import { CredentialsManager } from "../src/credentials";
import { requiresProfileReauthorization, TokenRefresher } from "../src/oauth";
import { AccountStore } from "../src/accountStore";
import { buildBrowserAuthorizationUrl, parseBrowserTokenResponse } from "../src/browserOAuth";
import { claudeLockPaths, withClaudeConfigLocks } from "../src/claudeLock";
import { CredentialSync } from "../src/credentialSync";
import { sameIdentity } from "../src/identity";
import { ProfileActivityRegistry } from "../src/profileActivity";
import { SwitchService } from "../src/switchService";
import { ClaudeAuthIdentity, OAuthCreds } from "../src/types";

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log((cond ? "  PASS" : "  FAIL") + " - " + name);
  if (!cond) failures++;
}

console.log("parseUsage:");
// Real captured /api/oauth/usage response shape
const real = {
  five_hour: { utilization: 12.0, resets_at: "2026-06-25T11:00:00+00:00" },
  seven_day: { utilization: 8.0, resets_at: "2026-06-29T12:00:00+00:00" },
  limits: [
    { kind: "session", group: "session", percent: 12, severity: "normal", resets_at: "2026-06-25T11:00:00+00:00", is_active: true },
    { kind: "weekly_all", group: "weekly", percent: 8, severity: "normal", resets_at: "2026-06-29T12:00:00+00:00", is_active: false },
  ],
};
const snap = parseUsage(real as never);
check("2 windows from limits[]", snap.windows.length === 2);
check("sessionPercent = 12", snap.sessionPercent === 12);
check("weeklyPercent = 8", snap.weeklyPercent === 8);
check("session label", snap.windows[0].label === "Session (5h)");

const fb = parseUsage({ five_hour: { utilization: 50, resets_at: null }, seven_day: { utilization: 90, resets_at: null } } as never);
check("fallback sessionPercent = 50", fb.sessionPercent === 50);
check("fallback weeklyPercent = 90", fb.weeklyPercent === 90);

const em = parseUsage({} as never);
check("empty -> 0 windows, null percents", em.windows.length === 0 && em.sessionPercent === null);

console.log("CredentialsManager (temp file):");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-test-"));
const credPath = path.join(tmpDir, ".credentials.json");
process.env.TEST_CRED_PATH = credPath;
const mgr = new CredentialsManager();

const credsA = { accessToken: "AAA", refreshToken: "ra", expiresAt: 111, scopes: ["x"], subscriptionType: "pro" };
const credsB = { accessToken: "BBB", refreshToken: "rb", expiresAt: 222, scopes: ["y"], subscriptionType: "max" };

check("path resolves to override", mgr.getCredentialsPath() === credPath);
mgr.writeCreds(credsA as never);
check("write + read account A", mgr.readCurrent()?.accessToken === "AAA");

mgr.backupCurrent();
check("hasBackup after backup", mgr.hasBackup() === true);

mgr.writeCreds(credsB as never);
check("switch to account B", mgr.readCurrent()?.accessToken === "BBB");

mgr.restoreBackup();
check("undo restores account A", mgr.readCurrent()?.accessToken === "AAA");

fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: credsA, otherField: 123 }));
mgr.writeCreds(credsB as never);
const rawAfter = JSON.parse(fs.readFileSync(credPath, "utf8"));
check("preserves extra fields on write", rawAfter.otherField === 123 && rawAfter.claudeAiOauth.accessToken === "BBB");

check(
  "does not overwrite a credential file that Claude already rotated",
  mgr.writeCredsIfCurrent(credsA as never, credsB as never) === false &&
    mgr.readCurrent()?.refreshToken === "rb"
);
check(
  "compare-and-swap persists a rotation from the current generation",
  mgr.writeCredsIfCurrent(credsB as never, credsA as never) === true &&
    mgr.readCurrent()?.refreshToken === "ra"
);

fs.writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] } }));
check("empty tokens are not a current login", mgr.readCurrent() === null);

mgr.writeCreds(credsA as never);
let refusedIncompleteWrite = false;
try {
  mgr.writeCreds({ accessToken: "", refreshToken: "", expiresAt: 0, scopes: [] } as never);
} catch {
  refusedIncompleteWrite = true;
}
check("refuses to write incomplete credentials", refusedIncompleteWrite);
check("incomplete write does not overwrite existing credentials", mgr.readCurrent()?.accessToken === "AAA");

fs.rmSync(tmpDir, { recursive: true, force: true });

function createStore(): AccountStore {
  const globalState = new Map<string, unknown>();
  const workspaceState = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const memento = (values: Map<string, unknown>) => ({
    get: <T>(key: string, defaultValue?: T): T => (values.has(key) ? values.get(key) : defaultValue) as T,
    update: async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
  });

  return new AccountStore({
    globalState: memento(globalState),
    workspaceState: memento(workspaceState),
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
  } as never);
}

function runBrowserOAuthTests(): void {
  console.log("Browser OAuth:");
  const url = new URL(buildBrowserAuthorizationUrl(43123, "expected-state", "pkce-challenge"));
  check(
    "uses the Claude subscription authorization endpoint",
    url.origin === "https://claude.com" && url.pathname === "/cai/oauth/authorize"
  );
  check(
    "uses loopback callback and PKCE",
    url.searchParams.get("redirect_uri") === "http://127.0.0.1:43123/callback" &&
      url.searchParams.get("code_challenge") === "pkce-challenge" &&
      url.searchParams.get("code_challenge_method") === "S256"
  );
  check(
    "binds the authorization response to a random state",
    url.searchParams.get("state") === "expected-state"
  );

  const parsed = parseBrowserTokenResponse({
    access_token: "browser-access",
    refresh_token: "browser-refresh",
    expires_in: 3600,
    refresh_token_expires_in: 7200,
    scope: "user:profile user:inference",
    account: { email_address: "browser@example.com" },
    organization: { uuid: "org-browser", name: "Browser Org" },
  });
  check(
    "maps a browser token response to credentials",
    parsed.creds?.accessToken === "browser-access" &&
      parsed.creds.refreshToken === "browser-refresh" &&
      parsed.creds.scopes.join(" ") === "user:profile user:inference"
  );
  check(
    "maps account identity without the CLI",
    parsed.identity?.email === "browser@example.com" && parsed.identity.orgId === "org-browser"
  );
}

function runProfileActivityTests(): void {
  console.log("ProfileActivityRegistry:");
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-activity-test-"));
  const context = { globalStorageUri: { fsPath: storageDir } } as never;
  const owner = new ProfileActivityRegistry(context);
  const observer = new ProfileActivityRegistry(context);
  owner.setActiveProfile("profile-a");
  check("shares active-profile ownership across extension hosts", observer.isActive("profile-a"));
  owner.dispose();
  check("removes the window lease on disposal", !observer.isActive("profile-a"));
  observer.dispose();
  fs.rmSync(storageDir, { recursive: true, force: true });
}

async function runAccountStoreTests(): Promise<void> {
  console.log("AccountStore:");

  const store = createStore();
  const profile = await store.addFromCreds("Broken", {
    accessToken: "stored-access",
    refreshToken: "",
    expiresAt: 111,
    scopes: [],
  });

  const noRefreshStore = createStore();
  await noRefreshStore.addFromCreds("A", {
    accessToken: "a",
    refreshToken: "",
    expiresAt: 111,
    scopes: [],
  });
  const matched = await noRefreshStore.findByTokens({
    accessToken: "b",
    refreshToken: "",
    expiresAt: 222,
    scopes: [],
  });
  check("does not match accounts by empty refresh token", matched === undefined);

  await store.updateUsage(profile.id, {
    fetchedAt: 333,
    windows: [],
    sessionPercent: null,
    weeklyPercent: null,
    error: "Failed to refresh token: HTTP 400 invalid_grant",
    retryAfter: 444,
  });
  await store.clearUsageError(profile.id);
  const clearedUsage = store.get(profile.id)?.lastUsage;
  check("clearUsageError removes auth error", clearedUsage?.error === undefined);
  check("clearUsageError removes retry backoff", clearedUsage?.retryAfter === undefined);
  check("clearUsageError preserves usage timestamp", clearedUsage?.fetchedAt === 333);

  await store.updateUsage(profile.id, {
    fetchedAt: 555,
    windows: [],
    sessionPercent: null,
    weeklyPercent: null,
    error: "Failed to refresh token: HTTP 400 invalid_grant",
    retryAfter: 666,
  });
  await store.markRefreshTokenDead(profile.id, "stored-refresh");
  await store.updateCreds(profile.id, {
    accessToken: "reauth-access",
    refreshToken: "reauth-refresh",
    expiresAt: 777,
    scopes: ["user:profile"],
  });
  const reauthed = store.get(profile.id);
  check("new credentials clear auth error", reauthed?.lastUsage?.error === undefined);
  check("new credentials clear retry backoff", reauthed?.lastUsage?.retryAfter === undefined);
  check("new credentials clear the dead-token marker", reauthed?.deadRefreshTokenHash === undefined);

  await store.updateIdentity(profile.id, { email: "owner@example.com", orgId: "org-1" });
  await store.updateIdentity(profile.id, { accountUuid: "acct-1" });
  check(
    "identity updates merge instead of dropping known fields",
    store.get(profile.id)?.authEmail === "owner@example.com" &&
      store.get(profile.id)?.authAccountUuid === "acct-1"
  );
}

function runIdentityTests(): void {
  console.log("Identity:");
  check(
    "same account uuid matches",
    sameIdentity({ accountUuid: "a", orgId: "o" }, { accountUuid: "a", email: "x@y" })
  );
  check(
    "two people in one Team organization are different accounts",
    !sameIdentity({ email: "anna@team.com", orgId: "team" }, { email: "bob@team.com", orgId: "team" })
  );
  check(
    "one person in two organizations are different subscriptions",
    !sameIdentity({ email: "me@x.com", orgId: "personal" }, { email: "me@x.com", orgId: "team" })
  );
  check("email comparison ignores case", sameIdentity({ email: "Me@X.com" }, { email: "me@x.com" }));
  check(
    "legacy org-only identities still match",
    sameIdentity({ orgId: "o" }, { orgId: "o" })
  );
}

async function runClaudeLockTests(): Promise<void> {
  console.log("Claude Code compatible lock:");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-lock-test-"));
  const configDir = path.join(dir, "config");
  const [primary, legacy] = claudeLockPaths(configDir);

  let sawLocks = false;
  const result = await withClaudeConfigLocks([configDir], 1_000, async () => {
    sawLocks = fs.statSync(primary).isDirectory() && fs.existsSync(legacy);
    return 42;
  });
  check("uses Claude Code's .oauth_refresh.lock and legacy <dir>.lock", sawLocks);
  check("returns the action value", result.acquired && result.value === 42);
  check("releases both locks", !fs.existsSync(primary) && !fs.existsSync(legacy));

  fs.mkdirSync(primary);
  const busy = await withClaudeConfigLocks([configDir], 400, async () => 1);
  check("waits for a lock held by Claude Code", !busy.acquired);
  check("does not leave a partial lock behind", !fs.existsSync(legacy));

  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(primary, old, old);
  const stale = await withClaudeConfigLocks([configDir], 400, async () => 2);
  check("takes over a stale lock like proper-lockfile", stale.acquired && stale.value === 2);

  fs.rmSync(dir, { recursive: true, force: true });
}

interface SyncFixture {
  root: string;
  globalDir: string;
  store: AccountStore;
  manager: CredentialsManager;
  sync: CredentialSync;
  homeDir: (id: string) => string;
}

function createSyncFixture(identities: Record<string, ClaudeAuthIdentity> = {}): SyncFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cas-sync-test-"));
  const globalDir = path.join(root, "global");
  fs.mkdirSync(globalDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = globalDir;
  process.env.TEST_CRED_PATH = path.join(globalDir, ".credentials.json");
  const store = createStore();
  const manager = new CredentialsManager();
  const homeDir = (id: string) => path.join(root, "homes", id);
  const sync = new CredentialSync(store, manager, new TokenRefresher(), homeDir, async (creds) =>
    identities[creds.accessToken]
  );
  return { root, globalDir, store, manager, sync, homeDir };
}

function creds(name: string, expiresInMs: number, extra: Partial<OAuthCreds> = {}): OAuthCreds {
  return {
    accessToken: `${name}-access`,
    refreshToken: `${name}-refresh`,
    expiresAt: Date.now() + expiresInMs,
    scopes: ["user:profile", "user:inference"],
    ...extra,
  };
}

async function runCredentialSyncTests(): Promise<void> {
  console.log("CredentialSync:");
  const originalFetch = globalThis.fetch;
  let tokenCalls = 0;
  let tokenResponse: () => Response = () => new Response("{}", { status: 500 });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/oauth/token")) {
      tokenCalls++;
      return tokenResponse();
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    // 1. Claude Code rotated both tokens of the active login while we were not looking.
    {
      const f = createSyncFixture({
        "gen2-access": { accountUuid: "acct-a", email: "a@example.com" },
      });
      const a = await f.store.addFromCreds("A", creds("gen1", 3_600_000), {
        identity: { accountUuid: "acct-a", email: "a@example.com" },
      });
      f.manager.writeCreds(creds("gen2", 7_200_000));
      const state = await f.sync.syncCurrent();
      check("identifies a fully rotated active file by account", state.ownerId === a.id);
      check(
        "imports the rotated generation into the saved profile",
        (await f.store.getCreds(a.id))?.refreshToken === "gen2-refresh"
      );
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 2. A verified login of another, unsaved account is not imported into a profile.
    {
      const f = createSyncFixture({
        "other-access": { accountUuid: "acct-other", email: "other@example.com" },
      });
      const a = await f.store.addFromCreds("A", creds("a1", 3_600_000), {
        identity: { accountUuid: "acct-a", email: "a@example.com" },
      });
      f.manager.writeCreds(creds("other", 3_600_000));
      const state = await f.sync.syncCurrent();
      check("reports an unsaved login", state.unsavedIdentity?.email === "other@example.com");
      check("clears the active marker for an unsaved login", f.store.getActiveId() === undefined);
      check(
        "never copies another account's tokens into a profile",
        (await f.store.getCreds(a.id))?.refreshToken === "a1-refresh"
      );
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 3. A newer generation in the isolated dir is used without spending anything.
    {
      const f = createSyncFixture();
      const b = await f.store.addFromCreds("B", creds("b1", -60_000), { activate: false });
      f.manager.writeCreds(creds("b2", 3_600_000), f.homeDir(b.id));
      tokenCalls = 0;
      const fresh = await f.sync.getFreshCreds(b.id);
      check("adopts the newest generation from any copy", fresh.creds?.refreshToken === "b2-refresh");
      check("does not refresh when a valid generation exists", tokenCalls === 0);
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 4. Expired everywhere: refresh under Claude's lock and write back to every copy.
    {
      const f = createSyncFixture();
      const a = await f.store.addFromCreds("A", creds("a1", -60_000));
      f.manager.writeCreds(creds("a1", -60_000));
      tokenCalls = 0;
      let lockHeldDuringRefresh = false;
      tokenResponse = () => {
        lockHeldDuringRefresh = fs.existsSync(path.join(f.globalDir, ".oauth_refresh.lock"));
        return new Response(
          JSON.stringify({
            access_token: "a2-access",
            refresh_token: "a2-refresh",
            expires_in: 28_800,
            account: { uuid: "acct-a", email_address: "a@example.com" },
            organization: { uuid: "org-a" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };
      const fresh = await f.sync.getFreshCreds(a.id);
      check("refreshes an expired login once", fresh.ok && tokenCalls === 1);
      check("holds Claude Code's lock while spending the refresh token", lockHeldDuringRefresh);
      check(
        "writes the rotation back to Claude Code's credentials file",
        f.manager.readCurrent()?.refreshToken === "a2-refresh"
      );
      check(
        "stores the rotation in the vault",
        (await f.store.getCreds(a.id))?.refreshToken === "a2-refresh"
      );
      check("records the account identity from the token response", f.store.get(a.id)?.authAccountUuid === "acct-a");
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 5. invalid_grant: never retried; a later login in the isolated dir recovers it.
    {
      const f = createSyncFixture();
      const b = await f.store.addFromCreds("B", creds("dead", -60_000), { activate: false });
      tokenCalls = 0;
      tokenResponse = () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      const first = await f.sync.getFreshCreds(b.id);
      const second = await f.sync.getFreshCreds(b.id);
      check("invalid_grant requires reauthorization", first.needsReauthorization === true);
      check("a rejected refresh token is never sent again", second.needsReauthorization === true && tokenCalls === 1);
      f.manager.writeCreds(creds("relogin", 3_600_000), f.homeDir(b.id));
      const recovered = await f.sync.getFreshCreds(b.id);
      check("recovers as soon as a new generation appears", recovered.creds?.refreshToken === "relogin-refresh");
      check("recovery clears the dead marker", f.store.get(b.id)?.deadRefreshTokenHash === undefined);
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 6. Claude Code is refreshing right now: back off instead of racing it.
    {
      const f = createSyncFixture();
      const a = await f.store.addFromCreds("A", creds("a1", -60_000));
      f.manager.writeCreds(creds("a1", -60_000));
      fs.mkdirSync(path.join(f.globalDir, ".oauth_refresh.lock"));
      tokenCalls = 0;
      const sync = f.sync as unknown as { getFreshCreds: CredentialSync["getFreshCreds"] };
      const started = Date.now();
      const fresh = await Promise.race([
        sync.getFreshCreds(a.id),
        new Promise<{ deferred: true }>((resolve) => setTimeout(() => resolve({ deferred: true }), 20_000)),
      ]);
      check("defers while Claude Code holds the refresh lock", "deferred" in fresh && fresh.deferred === true);
      check("does not spend the token Claude Code is refreshing", tokenCalls === 0);
      check("gives up within the lock timeout", Date.now() - started < 20_000);
      fs.rmSync(f.root, { recursive: true, force: true });
    }

    // 7. Switching saves the outgoing rotation, then installs the target login.
    {
      const f = createSyncFixture({
        "a2-access": { accountUuid: "acct-a", email: "a@example.com" },
      });
      const a = await f.store.addFromCreds("A", creds("a1", 3_600_000), {
        identity: { accountUuid: "acct-a", email: "a@example.com", orgId: "org-a" },
      });
      const b = await f.store.addFromCreds(
        "B",
        creds("b1", 3_600_000),
        {
          identity: { accountUuid: "acct-b", email: "b@example.com", orgId: "org-b" },
          activate: false,
        }
      );
      await f.store.setOAuthAccount(b.id, { accountUuid: "acct-b", emailAddress: "b@example.com" });
      f.manager.writeCreds(creds("a2", 7_200_000), undefined, { organizationUuid: "org-a" });
      fs.writeFileSync(
        path.join(f.globalDir, ".claude.json"),
        JSON.stringify({ keep: 1, oauthAccount: { accountUuid: "acct-a" } })
      );
      const state = await f.sync.syncCurrent();
      const installed = await f.sync.installInConfigDir(b.id, f.globalDir, state.ownerId);
      const raw = JSON.parse(fs.readFileSync(path.join(f.globalDir, ".credentials.json"), "utf8"));
      const config = JSON.parse(fs.readFileSync(path.join(f.globalDir, ".claude.json"), "utf8"));
      check("switch succeeds", installed.ok === true && f.store.getActiveId() === b.id);
      check(
        "outgoing profile keeps Claude Code's latest rotation",
        (await f.store.getCreds(a.id))?.refreshToken === "a2-refresh"
      );
      check("target tokens are written", raw.claudeAiOauth.refreshToken === "b1-refresh");
      check("organizationUuid follows the target account", raw.organizationUuid === "org-b");
      check(
        "Claude Code's cached oauthAccount follows the target account",
        config.oauthAccount.accountUuid === "acct-b" && config.keep === 1
      );
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLAUDE_CONFIG_DIR;
  }
}

async function runUsagePollerTests(): Promise<void> {
  console.log("UsagePoller:");
  const originalFetch = globalThis.fetch;
  const f = createSyncFixture();
  const a = await f.store.addFromCreds("A", creds("a1", 3_600_000));
  f.manager.writeCreds(creds("a1", 3_600_000));
  let usageCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth/usage")) {
      usageCalls++;
      const auth = (init?.headers as Record<string, string>).Authorization;
      return auth === "Bearer a2-access"
        ? new Response(JSON.stringify({ five_hour: { utilization: 7, resets_at: null } }), { status: 200 })
        : new Response("unauthorized", { status: 401 });
    }
    if (url.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({ access_token: "a2-access", refresh_token: "a2-refresh", expires_in: 28_800 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  try {
    const poller = new UsagePoller(f.store, f.sync, () => 240, () => undefined);
    await poller.pollOne(a.id, true);
    check("a 401 triggers one locked refresh and a retry", usageCalls === 2);
    check("usage is stored after the retry", f.store.get(a.id)?.lastUsage?.sessionPercent === 7);
    check(
      "the retry's rotation reaches Claude Code's file",
      f.manager.readCurrent()?.refreshToken === "a2-refresh"
    );
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}

async function runSwitchServiceTests(): Promise<void> {
  console.log("SwitchService:");

  const f = createSyncFixture();
  const profile = await f.store.addFromCreds("Newater2", {
    accessToken: "stored-access",
    refreshToken: "",
    expiresAt: 111,
    scopes: [],
  });
  f.manager.writeCreds({
    accessToken: "current-access",
    refreshToken: "current-refresh",
    expiresAt: 222,
    scopes: ["user:profile"],
  });

  const service = new SwitchService(f.store, f.manager, f.sync);
  const switchResult = await service.switchTo(profile.id);
  check(
    "incomplete profile switch requests reauthorization",
    !switchResult.ok && switchResult.reauthProfileId === profile.id
  );
  check(
    "switch does not store current login into incomplete profile",
    (await f.store.getCreds(profile.id))?.refreshToken === ""
  );

  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(f.root, { recursive: true, force: true });
}

async function runTokenRefresherTests(): Promise<void> {
  console.log("TokenRefresher:");
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        access_token: "next-access",
        refresh_token: "next-refresh",
        expires_in: 3600,
        refresh_token_expires_in: 7200,
        scope: "user:profile user:inference",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const before = Date.now();
    const refreshed = await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 111,
      refreshTokenExpiresAt: 222,
      scopes: ["user:profile", "user:inference"],
      clientId: "custom-client",
    });
    const body = JSON.parse(String(capturedInit?.body));
    const headers = capturedInit?.headers as Record<string, string>;

    check("uses current Claude Code token endpoint", capturedUrl === "https://platform.claude.com/v1/oauth/token");
    check("sends JSON token refresh body", headers["Content-Type"] === "application/json");
    check("sends oauth beta header", headers["anthropic-beta"] === "oauth-2025-04-20");
    check("sends user agent", headers["User-Agent"] === "claude-code-account-switcher");
    check("includes grant type", body.grant_type === "refresh_token");
    check("includes refresh token", body.refresh_token === "old-refresh");
    check("uses credential clientId when present", body.client_id === "custom-client");
    check("includes credential scopes", body.scope === "user:profile user:inference");
    check("stores rotated access token", refreshed.creds?.accessToken === "next-access");
    check("stores rotated refresh token", refreshed.creds?.refreshToken === "next-refresh");
    check("stores refresh token expiry", (refreshed.creds?.refreshTokenExpiresAt ?? 0) >= before + 7_199_000);
    check("updates response scopes", refreshed.creds?.scopes.join(" ") === "user:profile user:inference");

    capturedInit = undefined;
    await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 111,
      scopes: [],
    });
    const defaultScopeBody = JSON.parse(String(capturedInit?.body));
    check(
      "uses default Claude Code scopes when missing",
      defaultScopeBody.scope ===
        "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins"
    );

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const missingRefresh = await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "",
      expiresAt: 111,
      scopes: [],
    });
    check("does not request without refresh token", !missingRefresh.ok && fetchCalls === 0);
    check("missing refresh token requires reauthorization", missingRefresh.requiresReauthorization === true);

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token not found or invalid",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )) as typeof fetch;
    const invalidGrant = await new TokenRefresher().refresh({
      accessToken: "old-access",
      refreshToken: "dead-refresh",
      expiresAt: 111,
      scopes: ["user:profile"],
    });
    check("invalid_grant requires reauthorization", invalidGrant.requiresReauthorization === true);
    check("invalid_grant error stays recognizable", requiresProfileReauthorization(invalidGrant.error));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runProfileActivityTests();
runBrowserOAuthTests();
runIdentityTests();
runAccountStoreTests()
  .then(runClaudeLockTests)
  .then(runCredentialSyncTests)
  .then(runUsagePollerTests)
  .then(runSwitchServiceTests)
  .then(runTokenRefresherTests)
  .then(() => {
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
