import { spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import {
  getConfiguredClaudeCommand,
  missingClaudeCliMessage,
  resolveClaudeCommand,
} from "./cli";
import { CredentialSync } from "./credentialSync";
import { hasUsableOAuthCreds } from "./credentialValidation";
import { getAccountConfigDir } from "./isolatedConfig";
import { ProfileActivityRegistry } from "./profileActivity";

export interface WarmupResult {
  ok: boolean;
  message: string;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class WarmupService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: AccountStore,
    private readonly sync: CredentialSync,
    private readonly profileActivity?: ProfileActivityRegistry
  ) {}

  getProfileConfigDir(id: string): string {
    return getAccountConfigDir(this.context, id);
  }

  async sayHi(id: string): Promise<WarmupResult> {
    const profile = this.store.get(id);
    if (!profile) {
      return { ok: false, message: "Profile not found." };
    }

    const current = await this.sync.syncCurrent();
    if (
      this.store.getActiveId() === id ||
      current.ownerId === id ||
      this.profileActivity?.isActive(id, { excludeSelf: true }) === true
    ) {
      return {
        ok: false,
        message:
          `"${profile.label}" is currently active. Skipping to avoid racing Claude Code for the same refresh token.`,
      };
    }

    const creds = await this.store.getCreds(id);
    if (!creds) {
      return { ok: false, message: `No stored credentials for "${profile.label}".` };
    }
    if (!hasUsableOAuthCreds(creds)) {
      return {
        ok: false,
        message:
          `"${profile.label}" needs reauthorization. Use "Claude: Reauthorize account profile" for this profile first.`,
      };
    }

    // Write the newest generation into the isolated dir, then let Claude Code own
    // the login while it runs: it refreshes under its lock in that same directory.
    this.profileActivity?.markPending(id);
    const prepared = await this.sync.prepareHomeDir(id);
    if (!prepared.ok) {
      return {
        ok: false,
        message: prepared.deferred
          ? `Token refresh is already running for "${profile.label}". Try again in a few seconds.`
          : `"${profile.label}" needs reauthorization. Use "Claude: Reauthorize account profile" for this profile first.`,
      };
    }

    const configuredCommand = getConfiguredClaudeCommand();
    const command = resolveClaudeCommand(configuredCommand);
    if (!command) {
      return {
        ok: false,
        message: `"${profile.label}" Say Hi failed: ${missingClaudeCliMessage()}`,
      };
    }

    const cfg = vscode.workspace.getConfiguration("claudeSwitcher");
    const model = cfg.get<string>("sayHiModel", "haiku").trim() || "haiku";
    const prompt = cfg.get<string>("sayHiPrompt", "Hi").trim() || "Hi";
    const timeoutMs = Math.max(15, cfg.get<number>("sayHiTimeoutSeconds", 120)) * 1000;

    const result = await runClaude(
      command,
      [
        "-p",
        prompt,
        "--model",
        model,
        "--max-turns",
        "1",
        "--no-session-persistence",
        "--disallowedTools",
        "*",
      ],
      { CLAUDE_CONFIG_DIR: this.getProfileConfigDir(id) },
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      timeoutMs
    );

    await this.sync.importHomeDir(id);

    if (result.timedOut) {
      return {
        ok: false,
        message: `"${profile.label}" Say Hi timed out after ${Math.round(timeoutMs / 1000)}s.`,
      };
    }

    if (result.code !== 0) {
      const details = (result.stderr || result.stdout).trim().slice(0, 300);
      return {
        ok: false,
        message:
          `"${profile.label}" Say Hi failed` +
          (details ? `: ${details}` : ` with exit code ${result.code ?? "unknown"}.`),
      };
    }

    return { ok: true, message: `Say Hi completed for "${profile.label}".` };
  }
}

function runClaude(
  command: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(...buildSpawnArgs(command, args), {
      cwd,
      env: { ...process.env, ...extraEnv },
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: e.message, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
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
