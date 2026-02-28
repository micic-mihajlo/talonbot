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

  assignedSession(taskId: string) {
    return `task-worker:${taskId}`;
  }

  async launch(repo: RepoRegistration, taskId: string): Promise<WorkerLaunchResult> {
    const worktree = await this.worktree.createWorktree(repo, taskId);
    return {
      ...worktree,
      assignedSession: this.assignedSession(taskId),
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
