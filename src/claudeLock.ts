import * as fs from "fs";
import * as path from "path";

export interface LockResult<T> {
  acquired: boolean;
  value?: T;
}

/**
 * Claude Code serializes OAuth refreshes with `proper-lockfile` locks on its config
 * directory: `<configDir>/.oauth_refresh.lock` plus the legacy `<configDir>.lock`.
 * A lock is a directory created atomically with mkdir; its holder touches the mtime
 * every few seconds and a lock older than 60s is considered stale.
 *
 * Taking the very same locks makes the extension one more well-behaved Claude Code
 * process: Claude Code re-reads the credentials after acquiring the lock and adopts
 * a generation the extension wrote, instead of spending an already rotated
 * single-use refresh token.
 */
const STALE_MS = 60_000;
const HEARTBEAT_MS = 2_000;
const RETRY_MIN_MS = 150;
const RETRY_JITTER_MS = 250;

export function claudeLockPaths(configDir: string): string[] {
  let real = configDir;
  try {
    real = fs.realpathSync(configDir);
  } catch {
    /* proper-lockfile falls back to the given path as well */
  }
  return [path.join(configDir, ".oauth_refresh.lock"), `${real}.lock`];
}

/**
 * Runs `action` while holding Claude Code's refresh locks for every given config
 * directory. Never hold this across a Claude Code process run in the same directory:
 * Claude Code gives up after a few retries and reports the login as busy.
 */
export async function withClaudeConfigLocks<T>(
  configDirs: string[],
  timeoutMs: number,
  action: () => Promise<T>
): Promise<LockResult<T>> {
  const dirs = uniqueDirs(configDirs);
  const deadline = Date.now() + timeoutMs;
  const held: string[] = [];

  const releaseAll = () => {
    while (held.length > 0) {
      const lock = held.pop()!;
      try {
        fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* a stale-lock takeover may already have removed it */
      }
    }
  };

  while (true) {
    let busy = false;
    for (const dir of dirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* acquiring below reports the real failure */
      }
      for (const lock of claudeLockPaths(dir)) {
        if (tryAcquire(lock)) {
          held.push(lock);
        } else {
          busy = true;
          break;
        }
      }
      if (busy) {
        break;
      }
    }

    if (!busy) {
      break;
    }
    // Like Claude Code, never wait while holding a partial set: that could deadlock
    // with a process acquiring the same locks in a different order.
    releaseAll();
    if (Date.now() >= deadline) {
      return { acquired: false };
    }
    await sleep(RETRY_MIN_MS + Math.random() * RETRY_JITTER_MS);
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    for (const lock of held) {
      try {
        fs.utimesSync(lock, now, now);
      } catch {
        /* lock removed underneath us; the CAS writes still protect the files */
      }
    }
  }, HEARTBEAT_MS);

  try {
    return { acquired: true, value: await action() };
  } finally {
    clearInterval(heartbeat);
    releaseAll();
  }
}

function tryAcquire(lock: string): boolean {
  try {
    fs.mkdirSync(lock);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
      throw e;
    }
  }

  try {
    const stat = fs.statSync(lock);
    if (Date.now() - stat.mtimeMs > STALE_MS) {
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
      return true;
    }
  } catch {
    /* lost the race for a stale lock, or it vanished: retry later */
  }
  return false;
}

function uniqueDirs(dirs: string[]): string[] {
  const seen = new Map<string, string>();
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.set(key, resolved);
    }
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, dir]) => dir);
}

export function sameDir(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
