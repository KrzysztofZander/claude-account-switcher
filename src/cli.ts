import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const DEFAULT_COMMAND = "claude";

export function getConfiguredClaudeCommand(): string {
  const cfg = vscode.workspace.getConfiguration("claudeSwitcher");
  return stripWrappingQuotes(cfg.get<string>("claudeCommand", DEFAULT_COMMAND).trim()) || DEFAULT_COMMAND;
}

export function resolveClaudeCommand(command: string): string | undefined {
  const clean = stripWrappingQuotes(command.trim()) || DEFAULT_COMMAND;
  const pathMatch = findOnPath(clean);
  if (pathMatch) {
    return pathMatch;
  }

  if (process.platform === "win32") {
    const common = findCommonWindowsClaudeCommand();
    if (common) {
      return common;
    }
  }

  return clean === DEFAULT_COMMAND ? undefined : clean;
}

export function missingClaudeCliMessage(): string {
  return [
    "Claude Code CLI was not found.",
    "Install Claude Code, restart VS Code so PATH is refreshed, or set claudeSwitcher.claudeCommand to the full path of claude/claude.cmd.",
    "On Windows the command is often in %APPDATA%\\npm\\claude.cmd or %LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\claude.exe.",
  ].join(" ");
}

/**
 * Builds the `spawn` arguments for the Claude CLI.
 *
 * On Windows a `.cmd`/`.bat` shim cannot be executed directly, so it has to go
 * through `cmd.exe /c` — and that puts two parsers in series: cmd.exe reads the
 * line first, then the command applies the C runtime's argv rules. Quoting only
 * for the second parser is what makes this dangerous: cmd.exe does not honour
 * `\"`, so a quote inside a value ends the quoted region and any `&` or `|`
 * after it is run by cmd as a separate command.
 *
 * Returns null when an argument contains something cmd.exe cannot be made to
 * treat as data (newlines, or `%` which is expanded before any escaping
 * applies). Callers report that instead of running a command they cannot
 * predict. On every other platform the command is executed directly, with no
 * shell involved, so no escaping is needed.
 */
export function buildSpawnArgs(
  command: string,
  args: string[]
): [string, string[]] | null {
  if (process.platform !== "win32" || !isWindowsShellScript(command)) {
    return [command, args];
  }

  const parts: string[] = [];
  for (const value of ["call", command, ...args]) {
    const quoted = value === "call" ? value : quoteCmdArg(value);
    if (quoted === null) {
      return null;
    }
    parts.push(quoted);
  }
  return ["cmd.exe", ["/d", "/c", parts.join(" ")]];
}

export function unsafeCommandArgumentMessage(): string {
  return (
    "A Claude command argument contains a character that cmd.exe cannot quote " +
    "safely (a newline or '%'). Adjust claudeSwitcher.sayHiPrompt, " +
    "claudeSwitcher.sayHiModel or claudeSwitcher.claudeCommand and try again."
  );
}

function isWindowsShellScript(command: string): boolean {
  const ext = path.extname(command).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function quoteCmdArg(arg: string): string | null {
  // `%` is expanded by cmd.exe before any escaping is considered, and a newline
  // ends the command line outright. Neither can be neutralized here.
  if (/[%\r\n]/.test(arg)) {
    return null;
  }

  // Layer 1 — the C runtime's argv rules: escape quotes and double any run of
  // backslashes that precedes one (or ends the value, where the closing quote
  // would otherwise consume them).
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");

  // Layer 2 — cmd.exe's own parser. Caret-escape every metacharacter, the
  // surrounding quotes included, so cmd passes the whole token through as data
  // and only the command itself interprets the quoting above.
  return `"${escaped}"`.replace(/[()<>&|^"]/g, "^$&");
}

export function quoteForTerminal(command: string): string {
  if (process.platform === "win32") {
    return command.includes(" ") ? `"${command.replace(/"/g, '\\"')}"` : command;
  }
  return command.includes(" ") ? `'${command.replace(/'/g, "'\\''")}'` : command;
}

function stripWrappingQuotes(value: string): string {
  let current = value.trim();
  for (let i = 0; i < 3; i++) {
    if (
      (current.startsWith('"') && current.endsWith('"')) ||
      (current.startsWith("'") && current.endsWith("'"))
    ) {
      current = current.slice(1, -1).trim();
      continue;
    }

    if (
      (current.startsWith('\\"') && current.endsWith('\\"')) ||
      (current.startsWith("\\'") && current.endsWith("\\'"))
    ) {
      current = current.slice(2, -2).trim();
      continue;
    }

    break;
  }
  return current;
}

function findOnPath(command: string): string | undefined {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const candidates = hasPathSeparator ? expandExecutableCandidates(command) : pathCandidates(command);
  return candidates.find((candidate) => fileExists(candidate));
}

function pathCandidates(command: string): string[] {
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const names = expandExecutableCandidates(command);
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function expandExecutableCandidates(command: string): string[] {
  if (process.platform !== "win32" || path.extname(command)) {
    return [command];
  }

  const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return [command, ...pathExt.map((ext) => command + ext.toLowerCase())];
}

function findCommonWindowsClaudeCommand(): string | undefined {
  const env = process.env;
  const candidates = [
    env.APPDATA && path.join(env.APPDATA, "npm", "claude.cmd"),
    env.APPDATA && path.join(env.APPDATA, "npm", "claude.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "pnpm", "claude.cmd"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "claude.exe"),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "claude.cmd"),
    env.USERPROFILE && path.join(env.USERPROFILE, ".bun", "bin", "claude.cmd"),
    env.USERPROFILE && path.join(env.USERPROFILE, ".bun", "bin", "claude.exe"),
    env.USERPROFILE && path.join(env.USERPROFILE, "scoop", "shims", "claude.cmd"),
    env.USERPROFILE && path.join(env.USERPROFILE, "scoop", "shims", "claude.exe"),
    env.ProgramFiles && path.join(env.ProgramFiles, "nodejs", "claude.cmd"),
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => fileExists(candidate));
}

function fileExists(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}
