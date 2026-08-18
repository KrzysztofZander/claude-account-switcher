import { spawn } from "child_process";
import * as fs from "fs";
import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import {
  buildSpawnArgs,
  getConfiguredClaudeCommand,
  missingClaudeCliMessage,
  resolveClaudeCommand,
  unsafeCommandArgumentMessage,
} from "./cli";
import { hasUsableOAuthCreds } from "./credentialValidation";
import { CredentialsManager } from "./credentials";
import { getAccountConfigDir } from "./isolatedConfig";
import { withFileLock } from "./lock";
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
    private readonly credentials: CredentialsManager,
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

    const currentFileProfileId = await this.findCurrentFileProfileId();
    if (
      this.store.getActiveId() === id ||
      currentFileProfileId === id ||
      this.profileActivity?.isActive(id) === true
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

    const locked = await withFileLock(`refresh:${id}`, 30_000, async () => {
      if (this.profileActivity?.isActive(id) === true) {
        return {
          ok: false,
          message: `"${profile.label}" became active in another window. Say Hi was skipped.`,
        };
      }
      this.profileActivity?.markPending(id);
      const latestCreds = (await this.store.getCreds(id)) ?? creds;
      if (!hasUsableOAuthCreds(latestCreds)) {
        return {
          ok: false,
          message:
            `"${profile.label}" needs reauthorization. Use "Claude: Reauthorize account profile" for this profile first.`,
        };
      }
      const configDir = this.getProfileConfigDir(id);
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      this.credentials.writeCreds(latestCreds, configDir);

      // Kept only while a rotation might exist nowhere else: this file is the
      // recovery path readProfileCreds uses if persisting it fails.
      let persisted = true;
      try {
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
          { CLAUDE_CONFIG_DIR: configDir },
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
          timeoutMs
        );

        const updatedCreds = this.credentials.readCurrent(configDir);
        if (updatedCreds) {
          persisted = false;
          await this.store.updateCreds(id, updatedCreds);
          persisted = true;
        }

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
      } finally {
        // Say Hi refuses to run against an active profile, so nothing else reads this.
        if (persisted) {
          this.credentials.removeCredentials(configDir);
        }
      }
    });

    if (!locked.acquired) {
      return {
        ok: false,
        message: `Token refresh or Say Hi is already running for "${profile.label}" in another window.`,
      };
    }

    return locked.value ?? { ok: false, message: `Say Hi failed for "${profile.label}".` };
  }

  private async findCurrentFileProfileId(): Promise<string | undefined> {
    const current = this.credentials.readCurrent();
    return current ? this.store.findByTokens(current) : undefined;
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
    const spawnArgs = buildSpawnArgs(command, args);
    if (!spawnArgs) {
      resolve({
        code: -1,
        signal: null,
        stdout: "",
        stderr: unsafeCommandArgumentMessage(),
        timedOut: false,
      });
      return;
    }

    const child = spawn(...spawnArgs, {
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
