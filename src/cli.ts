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
 * Builds the `spawn` arguments for the Claude CLI. A Windows `.cmd`/`.bat` shim
 * goes through `cmd.exe /c`, which parses the line before the command's own argv
 * parser does; returns null when an argument cannot be quoted for both.
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
  // cmd.exe expands `%` before any escaping applies, and a newline ends the line.
  if (/[%\r\n]/.test(arg)) {
    return null;
  }

  // Escape for the command's argv parser, then caret-escape for cmd.exe itself:
  // cmd does not honour `\"`, so a quote would otherwise end the quoted region.
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
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
