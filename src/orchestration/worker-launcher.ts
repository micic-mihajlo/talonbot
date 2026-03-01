import type { RepoRegistration, TaskStatus, WorktreeInfo } from './types.js';
import { WorktreeManager } from './worktree-manager.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorkerLaunchResult extends WorktreeInfo {
  assignedSession: string;
}

export interface WorkerCleanupDecision {
  cleanup: boolean;
  reason: string;
}

interface WorkerLauncherOptions {
  sessionPrefix?: string;
  tmuxBinary?: string;
}

export class WorkerLauncher {
  private readonly sessionPrefix: string;
  private readonly tmuxBinary: string;

  constructor(
    private readonly worktree: WorktreeManager,
    options: WorkerLauncherOptions = {},
  ) {
    this.sessionPrefix = options.sessionPrefix?.trim() || 'dev-agent';
    this.tmuxBinary = options.tmuxBinary?.trim() || 'tmux';
  }

  private slug(input: string, fallback: string, maxLen: number) {
    const normalized = input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, maxLen);
    return normalized || fallback;
  }

  assignedSession(repoId: string, taskId: string, taskText = '') {
    const repo = this.slug(repoId, 'repo', 24);
    const todo = this.slug(taskText, this.slug(taskId, 'task', 16), 24);
    const idShort = this.slug(taskId, 'task', 12).slice(-8);
    return `${this.sessionPrefix}-${repo}-${todo}-${idShort}`;
  }

  async launch(repo: RepoRegistration, taskId: string, taskText = ''): Promise<WorkerLaunchResult> {
    const worktree = await this.worktree.createWorktree(repo, taskId);
    return {
      ...worktree,
      assignedSession: this.assignedSession(repo.id, taskId, taskText),
    };
  }

  async startTmuxSession(sessionName: string, worktreePath: string, command: string) {
    await this.killTmuxSession(sessionName).catch(() => undefined);
    await this.tmux(['new-session', '-d', '-s', sessionName, '-c', worktreePath, command]);
  }

  async hasTmuxSession(sessionName: string) {
    try {
      await this.tmux(['has-session', '-t', sessionName]);
      return true;
    } catch {
      return false;
    }
  }

  async waitForTmuxSessionExit(sessionName: string, timeoutMs: number, pollMs = 500) {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const exists = await this.hasTmuxSession(sessionName);
      if (!exists) return;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`tmux session "${sessionName}" did not exit within ${timeoutMs}ms`);
  }

  async killTmuxSession(sessionName: string) {
    await this.tmux(['kill-session', '-t', sessionName]).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('can\'t find session')) {
        return;
      }
      throw error;
    });
  }

  async listTmuxSessions() {
    const { stdout } = await this.tmux(['list-sessions', '-F', '#{session_name}']).catch(() => ({ stdout: '' }));
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  shouldCleanup(status: TaskStatus, options: { autoCleanup: boolean; failedRetentionHours: number }): WorkerCleanupDecision {
    if (!options.autoCleanup) {
      return {
        cleanup: false,
        reason: 'autocleanup_disabled',
      };
    }

    if (status === 'failed' || status === 'blocked') {
      if (options.failedRetentionHours > 0) {
        return {
          cleanup: false,
          reason: `retained_for_${options.failedRetentionHours}h`,
        };
      }

      return {
        cleanup: true,
        reason: 'failed_cleanup_immediate',
      };
    }

    return {
      cleanup: true,
      reason: 'terminal_cleanup',
    };
  }

  private async tmux(args: string[]) {
    return execFileAsync(this.tmuxBinary, args, {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
  }
}
