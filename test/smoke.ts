import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseUsage } from "../src/usage";
import { CredentialsManager } from "../src/credentials";
import { TokenRefresher } from "../src/oauth";

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

fs.rmSync(tmpDir, { recursive: true, force: true });

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
    check("includes grant type", body.grant_type === "refresh_token");
    check("includes refresh token", body.refresh_token === "old-refresh");
    check("uses credential clientId when present", body.client_id === "custom-client");
    check("includes credential scopes", body.scope === "user:profile user:inference");
    check("stores rotated access token", refreshed.creds?.accessToken === "next-access");
    check("stores rotated refresh token", refreshed.creds?.refreshToken === "next-refresh");
    check("stores refresh token expiry", (refreshed.creds?.refreshTokenExpiresAt ?? 0) >= before + 7_199_000);
    check("updates response scopes", refreshed.creds?.scopes.join(" ") === "user:profile user:inference");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

runTokenRefresherTests()
  .then(() => {
    console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
