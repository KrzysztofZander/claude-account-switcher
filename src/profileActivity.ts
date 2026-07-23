import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

interface ActivityLease {
  profileId: string;
  pid: number;
  updatedAt: number;
  expiresAt?: number;
}

const HEARTBEAT_MS = 15_000;
const STALE_MS = 60_000;
const PENDING_MS = 300_000;

/**
 * Records which saved profile is attached to a live VS Code window. Usage pollers
 * in other extension hosts consult these leases before attempting a rotating-token
 * refresh, so Claude Code remains the sole refresh owner for active sessions.
 */
export class ProfileActivityRegistry implements vscode.Disposable {
  private readonly leaseDir: string;
  private readonly sessionPath: string;
  private activeProfileId: string | undefined;
  private readonly timer: NodeJS.Timeout;

  constructor(context: vscode.ExtensionContext) {
    this.leaseDir = path.join(context.globalStorageUri.fsPath, "profile-activity");
    this.sessionPath = path.join(
      this.leaseDir,
      `window-${process.pid}-${crypto.randomUUID()}.json`
    );
    this.timer = setInterval(() => this.writeSessionLease(), HEARTBEAT_MS);
  }

  setActiveProfile(id: string | undefined): void {
    this.activeProfileId = id;
    this.writeSessionLease();
  }

  /** Protects a profile while a newly opened account window is still starting. */
  markPending(id: string): void {
    const file = path.join(
      this.leaseDir,
      `pending-${process.pid}-${crypto.randomUUID()}.json`
    );
    this.writeLease(file, {
      profileId: id,
      pid: process.pid,
      updatedAt: Date.now(),
      expiresAt: Date.now() + PENDING_MS,
    });
  }

  isActive(id: string): boolean {
    let files: string[];
    try {
      files = fs.readdirSync(this.leaseDir);
    } catch {
      return false;
    }

    const now = Date.now();
    let active = false;
    for (const name of files) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const file = path.join(this.leaseDir, name);
      const lease = this.readLease(file);
      const expired =
        !lease ||
        (lease.expiresAt !== undefined
          ? lease.expiresAt <= now
          : now - lease.updatedAt > STALE_MS || !isProcessRunning(lease.pid));
      if (expired) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* best effort cleanup */
        }
        continue;
      }
      if (lease.profileId === id) {
        active = true;
      }
    }
    return active;
  }

  dispose(): void {
    clearInterval(this.timer);
    try {
      fs.unlinkSync(this.sessionPath);
    } catch {
      /* already absent */
    }
  }

  private writeSessionLease(): void {
    if (!this.activeProfileId) {
      try {
        fs.unlinkSync(this.sessionPath);
      } catch {
        /* already absent */
      }
      return;
    }
    this.writeLease(this.sessionPath, {
      profileId: this.activeProfileId,
      pid: process.pid,
      updatedAt: Date.now(),
    });
  }

  private writeLease(file: string, lease: ActivityLease): void {
    let tmp: string | undefined;
    try {
      fs.mkdirSync(this.leaseDir, { recursive: true });
      tmp = `${file}.tmp-${crypto.randomUUID()}`;
      fs.writeFileSync(tmp, JSON.stringify(lease), { encoding: "utf8", mode: 0o600 });
      try {
        fs.renameSync(tmp, file);
      } catch (e) {
        if (!["EEXIST", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) {
          throw e;
        }
        fs.unlinkSync(file);
        fs.renameSync(tmp, file);
      }
    } catch {
      /* A missing lease only disables the optimization; token writes remain guarded. */
      if (tmp) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* already absent */
        }
      }
    }
  }

  private readLease(file: string): ActivityLease | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ActivityLease>;
      if (
        typeof parsed.profileId !== "string" ||
        typeof parsed.pid !== "number" ||
        typeof parsed.updatedAt !== "number"
      ) {
        return null;
      }
      return parsed as ActivityLease;
    } catch {
      return null;
    }
  }
}

function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
