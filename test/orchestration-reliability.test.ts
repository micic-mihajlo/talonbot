import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { config as defaultConfig } from '../src/config.js';
import type { AppConfig } from '../src/config.js';
import { TaskOrchestrator } from '../src/orchestration/task-orchestrator.js';
import { WorkerLauncher } from '../src/orchestration/worker-launcher.js';
import { WorktreeManager } from '../src/orchestration/worktree-manager.js';
import { OrchestrationHealthMonitor } from '../src/orchestration/health-monitor.js';
import type { TaskRecord } from '../src/orchestration/types.js';

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 10000, intervalMs = 50) => {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for condition');
};

const exists = async (target: string) =>
  access(target)
    .then(() => true)
    .catch(() => false);

const initGitRepo = async (repoDir: string) => {
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, 'README.md'), '# repo\n', 'utf8');

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
};

const buildConfig = (sandbox: string, overrides: Partial<AppConfig> = {}): AppConfig => ({
  ...defaultConfig,
  DATA_DIR: path.join(sandbox, 'data'),
  WORKTREE_ROOT_DIR: path.join(sandbox, 'worktrees'),
  REPO_ROOT_DIR: path.join(sandbox, 'workspace'),
  RELEASE_ROOT_DIR: path.join(sandbox, 'release-root'),
  CONTROL_SOCKET_PATH: path.join(sandbox, 'data', 'control.sock'),
  TASK_MAX_CONCURRENCY: 1,
  WORKER_MAX_RETRIES: 0,
  TASK_AUTOCLEANUP: false,
  TASK_AUTO_COMMIT: false,
  TASK_AUTO_PR: false,
  FAILED_WORKTREE_RETENTION_HOURS: 1,
  TASK_STUCK_MINUTES: 30,
  TASK_QUEUE_STALE_MINUTES: 30,
  ENGINE_MODE: 'mock',
  STARTUP_INTEGRITY_MODE: 'warn',
  ...overrides,
});

describe('task orchestration reliability upgrades', () => {
  let sandbox = '';
  let orchestrator: TaskOrchestrator | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-orchestration-reliability-'));
  });

  afterEach(async () => {
    if (orchestrator) {
      await orchestrator.stop();
      orchestrator = null;
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  it('tracks deterministic execution state and auditable transitions', async () => {
    const repoDir = path.join(sandbox, 'repo');
    await initGitRepo(repoDir);

    orchestrator = new TaskOrchestrator(buildConfig(sandbox));
    await orchestrator.initialize();
    await orchestrator.registerRepo({
      id: 'repo',
      path: repoDir,
      defaultBranch: 'main',
      remote: 'origin',
      isDefault: true,
    });

    const task = await orchestrator.submitTask({
      text: 'Prepare implementation notes.',
      repoId: 'repo',
      source: 'operator',
    });

    await waitFor(() => orchestrator?.getTask(task.id)?.status === 'done', 15000);
    const done = orchestrator.getTask(task.id);
    expect(done?.status).toBe('done');
    expect(done?.state).toBe('done');
    expect(done?.assignedSession).toBe(`task-worker:${task.id}`);
    expect(done?.branch).toBe(`talon/${task.id}`);
    expect(done?.worktreePath).toContain(path.join(sandbox, 'worktrees'));
    expect(done?.artifacts.some((artifact) => artifact.kind === 'launcher')).toBe(true);
    expect(done?.artifacts.some((artifact) => artifact.kind === 'summary')).toBe(true);

    const transitions = done?.events.filter((event) => event.kind === 'status_transition') || [];
    expect(transitions.some((event) => event.details?.from === 'queued' && event.details?.to === 'running')).toBe(true);
    expect(transitions.some((event) => event.details?.from === 'running' && event.details?.to === 'done')).toBe(true);
  });

  it('reports no-artifact completion when concrete completion artifacts are missing', async () => {
    const repoDir = path.join(sandbox, 'repo-no-artifact');
    await initGitRepo(repoDir);

    orchestrator = new TaskOrchestrator(buildConfig(sandbox));
    await orchestrator.initialize();
    await orchestrator.registerRepo({
      id: 'repo-no-artifact',
      path: repoDir,
      defaultBranch: 'main',
      remote: 'origin',
      isDefault: true,
    });

    const task = await orchestrator.submitTask({
      text: 'Return summary only.',
      repoId: 'repo-no-artifact',
      source: 'operator',
    });

    await waitFor(() => orchestrator?.getTask(task.id)?.status === 'done', 15000);
    const report = orchestrator.buildTaskReport(task.id);
    expect(report?.status).toBe('done');
    expect(report?.artifactState).toBe('no-artifact');
    expect(report?.message).toContain('no completion artifacts');
  });

  it('applies deterministic launcher cleanup policy for failed tasks', async () => {
    const repoDir = path.join(sandbox, 'repo-fail-cleanup');
    await initGitRepo(repoDir);

    orchestrator = new TaskOrchestrator(
      buildConfig(sandbox, {
        ENGINE_MODE: 'process',
        ENGINE_COMMAND: 'sh',
        ENGINE_ARGS: '-lc "exit 1"',
        TASK_AUTOCLEANUP: true,
        FAILED_WORKTREE_RETENTION_HOURS: 0,
      }),
    );
    await orchestrator.initialize();
    await orchestrator.registerRepo({
      id: 'repo-fail-cleanup',
      path: repoDir,
      defaultBranch: 'main',
      remote: 'origin',
      isDefault: true,
    });

    const task = await orchestrator.submitTask({
      text: 'This should fail.',
      repoId: 'repo-fail-cleanup',
      source: 'operator',
    });

    await waitFor(() => orchestrator?.getTask(task.id)?.status === 'failed', 15000);
    const failed = orchestrator.getTask(task.id);
    expect(failed?.status).toBe('failed');
    expect(failed?.worktreePath).toBeTruthy();
    await waitFor(async () => !(await exists(failed?.worktreePath || '')), 5000);
    expect(await exists(failed?.worktreePath || '')).toBe(false);
  });
});

describe('worker launcher + health monitor', () => {
  it('uses deterministic worker session naming and cleanup decisions', async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), 'talon-launcher-'));
    try {
      const manager = new WorktreeManager(path.join(sandbox, 'worktrees'));
      const launcher = new WorkerLauncher(manager);
      expect(launcher.assignedSession('task-123')).toBe('task-worker:task-123');
      expect(launcher.shouldCleanup('done', { autoCleanup: true, failedRetentionHours: 24 }).cleanup).toBe(true);
      expect(launcher.shouldCleanup('failed', { autoCleanup: true, failedRetentionHours: 24 }).cleanup).toBe(false);
      expect(launcher.shouldCleanup('failed', { autoCleanup: true, failedRetentionHours: 0 }).cleanup).toBe(true);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('flags orphaned workers, stuck tasks, and stale worktrees', () => {
    const monitor = new OrchestrationHealthMonitor();
    const now = Date.now();
    const runningTask: TaskRecord = {
      id: 'task-running',
      source: 'operator',
      text: 'running',
      repoId: 'repo',
      status: 'running',
      state: 'running',
      assignedSession: 'task-worker:task-running',
      workerSessionKey: 'task-worker:task-running',
      retryCount: 0,
      maxRetries: 1,
      escalationRequired: false,
      artifacts: [],
      children: [],
      createdAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 10 * 60_000).toISOString(),
      events: [],
    };

    const queuedTask: TaskRecord = {
      ...runningTask,
      id: 'task-queued',
      status: 'queued',
      state: 'queued',
      assignedSession: 'task-worker:task-queued',
      workerSessionKey: 'task-worker:task-queued',
      updatedAt: new Date(now - 12 * 60_000).toISOString(),
    };

    const snapshot = monitor.scan({
      tasks: [runningTask, queuedTask],
      runningTaskIds: ['unknown-worker-slot'],
      worktrees: [{ path: '/tmp/stale-worktree', mtimeMs: now - 5 * 60 * 60 * 1000 }],
      nowMs: now,
      staleRunningMs: 5 * 60 * 1000,
      staleQueuedMs: 5 * 60 * 1000,
      staleWorktreeMs: 60 * 60 * 1000,
    });

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.issues.some((issue) => issue.code === 'orphaned_running_task')).toBe(true);
    expect(snapshot.issues.some((issue) => issue.code === 'orphaned_worker_slot')).toBe(true);
    expect(snapshot.issues.some((issue) => issue.code === 'stuck_running_task')).toBe(true);
    expect(snapshot.issues.some((issue) => issue.code === 'stale_queued_task')).toBe(true);
    expect(snapshot.issues.some((issue) => issue.code === 'stale_worktree')).toBe(true);
  });
});
