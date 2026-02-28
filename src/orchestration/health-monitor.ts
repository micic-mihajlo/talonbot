import type { TaskRecord } from './types.js';

export interface HealthMonitorIssue {
  severity: 'warn' | 'error';
  code: string;
  message: string;
  taskId?: string;
  worktreePath?: string;
  ageMs?: number;
}

export interface OrchestrationHealthSnapshot {
  status: 'ok' | 'degraded';
  scannedAt: string;
  metrics: {
    tasksTotal: number;
    queued: number;
    running: number;
    done: number;
    failed: number;
    blocked: number;
    cancelled: number;
    worktrees: number;
    issues: number;
  };
  issues: HealthMonitorIssue[];
}

export interface HealthMonitorInput {
  tasks: TaskRecord[];
  runningTaskIds: string[];
  worktrees: Array<{ path: string; mtimeMs: number }>;
  nowMs?: number;
  staleRunningMs: number;
  staleQueuedMs: number;
  staleWorktreeMs: number;
}

const parseAtMs = (value?: string) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};

export class OrchestrationHealthMonitor {
  scan(input: HealthMonitorInput): OrchestrationHealthSnapshot {
    const nowMs = input.nowMs ?? Date.now();
    const runningSet = new Set(input.runningTaskIds);
    const byId = new Map(input.tasks.map((task) => [task.id, task]));
    const issues: HealthMonitorIssue[] = [];

    for (const task of input.tasks) {
      if (task.status !== 'running') continue;

      if (!runningSet.has(task.id)) {
        issues.push({
          severity: 'error',
          code: 'orphaned_running_task',
          message: `Task ${task.id} is running but has no tracked worker slot.`,
          taskId: task.id,
        });
      }

      const ageMs = nowMs - parseAtMs(task.updatedAt || task.startedAt || task.createdAt);
      if (ageMs > input.staleRunningMs) {
        issues.push({
          severity: 'warn',
          code: 'stuck_running_task',
          message: `Task ${task.id} has been running for ${Math.round(ageMs / 1000)}s without updates.`,
          taskId: task.id,
          ageMs,
        });
      }
    }

    for (const runningTaskId of runningSet) {
      const task = byId.get(runningTaskId);
      if (!task) {
        issues.push({
          severity: 'error',
          code: 'orphaned_worker_slot',
          message: `Worker slot references missing task ${runningTaskId}.`,
          taskId: runningTaskId,
        });
        continue;
      }

      if (task.status !== 'running') {
        issues.push({
          severity: 'error',
          code: 'worker_slot_status_mismatch',
          message: `Worker slot for ${runningTaskId} is active but task status is ${task.status}.`,
          taskId: runningTaskId,
        });
      }
    }

    for (const task of input.tasks) {
      if (task.status !== 'queued') continue;
      const ageMs = nowMs - parseAtMs(task.updatedAt || task.createdAt);
      if (ageMs > input.staleQueuedMs) {
        issues.push({
          severity: 'warn',
          code: 'stale_queued_task',
          message: `Task ${task.id} has been queued for ${Math.round(ageMs / 1000)}s.`,
          taskId: task.id,
          ageMs,
        });
      }
    }

    const activeWorktreePaths = new Set(
      input.tasks
        .filter((task) => task.status === 'running' || task.status === 'queued')
        .map((task) => task.worktreePath)
        .filter((value): value is string => Boolean(value)),
    );

    for (const worktree of input.worktrees) {
      if (activeWorktreePaths.has(worktree.path)) continue;
      const ageMs = nowMs - worktree.mtimeMs;
      if (ageMs > input.staleWorktreeMs) {
        issues.push({
          severity: 'warn',
          code: 'stale_worktree',
          message: `Stale worktree detected: ${worktree.path}`,
          worktreePath: worktree.path,
          ageMs,
        });
      }
    }

    const metrics = {
      tasksTotal: input.tasks.length,
      queued: input.tasks.filter((task) => task.status === 'queued').length,
      running: input.tasks.filter((task) => task.status === 'running').length,
      done: input.tasks.filter((task) => task.status === 'done').length,
      failed: input.tasks.filter((task) => task.status === 'failed').length,
      blocked: input.tasks.filter((task) => task.status === 'blocked').length,
      cancelled: input.tasks.filter((task) => task.status === 'cancelled').length,
      worktrees: input.worktrees.length,
      issues: issues.length,
    };

    return {
      status: issues.length > 0 ? 'degraded' : 'ok',
      scannedAt: new Date(nowMs).toISOString(),
      metrics,
      issues,
    };
  }
}
