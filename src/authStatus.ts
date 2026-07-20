import { spawn } from "child_process";
import * as path from "path";
import {
  getConfiguredClaudeCommand,
  missingClaudeCliMessage,
  resolveClaudeCommand,
} from "./cli";
import { ClaudeAuthIdentity } from "./types";

export interface ClaudeAuthStatus extends ClaudeAuthIdentity {
  loggedIn: boolean;
  subscriptionType?: string;
}

export async function readClaudeAuthStatus(
  configDir?: string
): Promise<{ ok: boolean; status?: ClaudeAuthStatus; error?: string }> {
  const configuredCommand = getConfiguredClaudeCommand();
  const resolvedCommand = resolveClaudeCommand(configuredCommand);
  if (!resolvedCommand) {
    return { ok: false, error: missingClaudeCliMessage() };
  }

  const result = await runClaudeStatus(resolvedCommand, configDir);
  const parsed = parseStatus(result.stdout || result.stderr);
  if (parsed) {
    return { ok: true, status: parsed };
  }

  const detail = (result.stderr || result.stdout).trim().slice(0, 300);
  return {
    ok: false,
    error: detail || `Claude auth status failed with exit code ${result.code ?? "unknown"}.`,
  };
}

function parseStatus(raw: string): ClaudeAuthStatus | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ClaudeAuthStatus>;
    return {
      loggedIn: parsed.loggedIn === true,
      email: nonEmpty(parsed.email),
      orgId: nonEmpty(parsed.orgId),
      orgName: nonEmpty(parsed.orgName),
      subscriptionType: nonEmpty(parsed.subscriptionType),
    };
  } catch {
    return null;
  }
}

function runClaudeStatus(
  command: string,
  configDir: string | undefined
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(...buildSpawnArgs(command, ["auth", "status", "--json"]), {
      env: configDir ? { ...process.env, CLAUDE_CONFIG_DIR: configDir } : process.env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      resolve({ code: -1, stdout, stderr: e.message });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function buildSpawnArgs(command: string, args: string[]): [string, string[]] {
  if (process.platform !== "win32") {
    return [command, args];
  }

  if (!isWindowsShellScript(command)) {
    return [command, args];
  }

  const line = ["call", quoteCmdArg(command), ...args.map(quoteCmdArg)].join(" ");
  return ["cmd.exe", ["/d", "/c", line]];
}

function isWindowsShellScript(command: string): boolean {
  const ext = path.extname(command).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
