import type { RepoRegistration, TaskStatus, WorktreeInfo } from './types.js';
import { WorktreeManager } from './worktree-manager.js';

export interface WorkerLaunchResult extends WorktreeInfo {
  assignedSession: string;
}

export interface WorkerCleanupDecision {
  cleanup: boolean;
  reason: string;
}

export class WorkerLauncher {
  constructor(private readonly worktree: WorktreeManager) {}

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
    return `dev-agent-${repo}-${todo}-${idShort}`;
  }

  async launch(repo: RepoRegistration, taskId: string, taskText = ''): Promise<WorkerLaunchResult> {
    const worktree = await this.worktree.createWorktree(repo, taskId);
    return {
      ...worktree,
      assignedSession: this.assignedSession(repo.id, taskId, taskText),
    };
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
}
