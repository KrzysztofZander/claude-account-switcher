import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface LockResult<T> {
  acquired: boolean;
  value?: T;
}

const LOCK_DIR = path.join(os.tmpdir(), "claude-account-switcher-locks");
const STALE_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPath(name: string): string {
  const hash = crypto.createHash("sha256").update(name).digest("hex").slice(0, 32);
  return path.join(LOCK_DIR, `${hash}.lock`);
}

/**
 * Small cross-process lock based on atomic file creation. It keeps multiple VS Code
 * windows from spending the same single-use refresh token at the same time.
 */
export async function withFileLock<T>(
  name: string,
  timeoutMs: number,
  action: () => Promise<T>
): Promise<LockResult<T>> {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = lockPath(name);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, createdAt: Date.now(), name }, null, 2)
      );
      const value = await action();
      return { acquired: true, value };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw e;
      }

      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          fs.unlinkSync(file);
          continue;
        }
      } catch {
        continue;
      }

      await sleep(150);
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(file);
        } catch {
          /* another process may already have cleaned a stale lock */
        }
      }
    }
  }

  return { acquired: false };
}
