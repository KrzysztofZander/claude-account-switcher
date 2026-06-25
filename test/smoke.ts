import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseUsage } from "../src/usage";
import { CredentialsManager } from "../src/credentials";
import { fmtResetCompact, buildAccountItems } from "../src/extension";
import { StatusBarController } from "../src/ui/statusBar";

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

console.log("fmtResetCompact:");
const now = Date.now();
check("< 1h -> minutes", fmtResetCompact(new Date(now + 45 * 60000).toISOString()) === "45m");
check("hours+minutes", fmtResetCompact(new Date(now + (2 * 60 + 15) * 60000).toISOString()) === "2h15m");
check("days+hours", fmtResetCompact(new Date(now + (3 * 24 + 4) * 3600000).toISOString()) === "3d4h");
check("past/zero -> now", fmtResetCompact(new Date(now - 1000).toISOString()) === "now");
check("null -> undefined", fmtResetCompact(null) === undefined);

console.log("buildAccountItems:");
const acct = {
  id: "a1",
  label: "Backup",
  subscriptionType: "pro",
  addedAt: 0,
  order: 0,
  lastUsage: {
    fetchedAt: now,
    sessionPercent: 1,
    weeklyPercent: 15,
    windows: [
      { kind: "session", label: "Session (5h)", percent: 1, severity: "normal", resetsAt: new Date(now + 135 * 60000).toISOString() },
      { kind: "weekly_all", label: "Weekly (all)", percent: 15, severity: "normal", resetsAt: new Date(now + (3 * 24 + 4) * 3600000).toISOString() },
    ],
  },
};
const itemsOut = buildAccountItems([acct as never], undefined);
check(
  "description has '5h: 1% - 2h15m | weekly: 15% - 3d4h'",
  itemsOut[0].description === "pro  ·  5h: 1% - 2h15m | weekly: 15% - 3d4h"
);

console.log("StatusBarController:");
const fakeStore = {
  getActiveId: () => "a1",
  get: (id: string) => (id === "a1" ? acct : undefined),
} as never;
const sb = new StatusBarController(fakeStore);
sb.refresh();
check(
  "status bar text shows '1%-15%'",
  (sb as never as { item: { text: string } }).item.text === "$(account) Backup · 1%-15%"
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
