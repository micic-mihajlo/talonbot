import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { config as defaultConfig } from '../src/config.js';
import type { AppConfig } from '../src/config.js';
import { ReleaseManager } from '../src/ops/release-manager.js';
import { TaskOrchestrator } from '../src/orchestration/task-orchestrator.js';
import { WorktreeManager } from '../src/orchestration/worktree-manager.js';
import { InboundBridge } from '../src/bridge/inbound-bridge.js';
import { runSecurityAudit } from '../src/security/audit.js';

const exists = async (target: string) =>
  access(target)
    .then(() => true)
    .catch(() => false);

const waitFor = async (predicate: () => boolean, timeoutMs = 10000, intervalMs = 50) => {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for condition');
};

const initGitRepo = async (repoDir: string) => {
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, 'README.md'), '# repo\n', 'utf8');

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
};

const baseConfig = (sandbox: string, overrides: Partial<AppConfig> = {}): AppConfig => ({
  ...defaultConfig,
  DATA_DIR: path.join(sandbox, 'data'),
  WORKTREE_ROOT_DIR: path.join(sandbox, 'worktrees'),
  REPO_ROOT_DIR: path.join(sandbox, 'workspace'),
  RELEASE_ROOT_DIR: path.join(sandbox, 'release-root'),
  CONTROL_SOCKET_PATH: path.join(sandbox, 'data', 'control.sock'),
  TASK_MAX_CONCURRENCY: 1,
  WORKER_MAX_RETRIES: 1,
  TASK_AUTOCLEANUP: true,
  TASK_AUTO_COMMIT: false,
  TASK_AUTO_PR: false,
  ENGINE_MODE: 'mock',
  STARTUP_INTEGRITY_MODE: 'warn',
  CONTROL_AUTH_TOKEN: 'a-very-long-control-token-for-tests-1234567890',
  SESSION_LOG_RETENTION_DAYS: 1,
  ...overrides,
});

describe('release manager strict integrity', () => {
  let sandbox = '';

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-release-strict-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('fails strict integrity when current or manifest is missing', async () => {
    const manager = new ReleaseManager(path.join(sandbox, 'releases'));
    await manager.initialize();

    const noCurrent = await manager.integrityCheck('strict');
    expect(noCurrent.ok).toBe(false);

    const sourceDir = path.join(sandbox, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'file.txt'), 'hello', 'utf8');

    const snapshot = await manager.createSnapshot(sourceDir);
    const active = await manager.activate(snapshot.sha);

    await rm(path.join(active, 'release-manifest.json'), { force: true });
    const missingManifest = await manager.integrityCheck('strict');
    expect(missingManifest.ok).toBe(false);
    expect(missingManifest.missing.some((entry) => entry.includes('release-manifest.json'))).toBe(true);
    await expect(manager.activate(snapshot.sha)).rejects.toThrow('release manifest missing');
  });
});

describe('task orchestrator failure + cancellation + fanout', () => {
  let sandbox = '';
  const orchestrators: TaskOrchestrator[] = [];

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-orchestrator-resilience-'));
  });

  afterEach(async () => {
    for (const orchestrator of orchestrators) {
      await orchestrator.stop();
    }
    orchestrators.length = 0;
    await rm(sandbox, { recursive: true, force: true });
  });

  it('marks task failed after retry exhaustion and sets escalation', async () => {
    const repoDir = path.join(sandbox, 'repo-fail');
    await initGitRepo(repoDir);

    const orchestrator = new TaskOrchestrator(
      baseConfig(sandbox, {
        ENGINE_MODE: 'process',
        ENGINE_COMMAND: 'sh',
        ENGINE_ARGS: '-lc "exit 1"',
        WORKER_MAX_RETRIES: 1,
      }),
    );
    orchestrators.push(orchestrator);

    await orchestrator.initialize();
    await orchestrator.registerRepo({
      id: 'repo-fail',
      path: repoDir,
      defaultBranch: 'main',
      remote: 'origin',
      isDefault: true,
    });

    const task = await orchestrator.submitTask({
      text: 'This should fail and escalate.',
      repoId: 'repo-fail',
      source: 'operator',
    });

    await waitFor(() => {
      const current = orchestrator.getTask(task.id);
      return Boolean(current && current.state === 'failed');
    }, 15000);

    const failed = orchestrator.getTask(task.id);
    expect(failed?.state).toBe('failed');
    expect(failed?.retryCount).toBe(2);
    expect(failed?.escalationRequired).toBe(true);
  });

  it('supports cancellation while a worker is running', async () => {
    const repoDir = path.join(sandbox, 'repo-cancel');
    await initGitRepo(repoDir);

    const orchestrator = new TaskOrchestrator(
      baseConfig(sandbox, {
        ENGINE_MODE: 'process',
        ENGINE_COMMAND: 'sh',
        ENGINE_ARGS: '-lc "sleep 1; echo done"',
        WORKER_MAX_RETRIES: 0,
      }),
    );
    orchestrators.push(orchestrator);

    await orchestrator.initialize();
    await orchestrator.registerRepo({
      id: 'repo-cancel',
      path: repoDir,
      defaultBranch: 'main',
      remote: 'origin',
      isDefault: true,
    });

    const task = await orchestrator.submitTask({
      text: 'Long-running task for cancel test.',
      repoId: 'repo-cancel',
      source: 'operator',
    });

    await waitFor(() => orchestrator.getTask(task.id)?.state === 'running', 5000);
    const cancelResult = await orchestrator.cancelTask(task.id);
    expect(cancelResult).toBe(true);

    await waitFor(() => {
      const state = orchestrator.getTask(task.id)?.state;
      return state === 'cancelled';
    }, 15000);

    expect(orchestrator.getTask(task.id)?.state).toBe('cancelled');
  });


  it('re-evaluates fanout parent status after child retries without invalid transitions', async () => {
    const repoDir = path.join(sandbox, 'repo-fanout-retry');
    await initGitRepo(repoDir);

    const orchestrator = new TaskOrchestrator(baseConfig(sandbox));
    orchestrators.push(orchestrator);
    await orchestrator.initialize();

    await orchestrator.registerRepo({
      id: 'repo-fanout-retry',
      path: repoDir,
      defaultBranch: 'main',
      remote: 'origin',
      isDefault: true,
    });

    const now = new Date().toISOString();
    const parent: any = {
      id: 'parent-1',
      source: 'operator',
      text: 'parent',
      repoId: 'repo-fanout-retry',
      status: 'failed',
      state: 'failed',
      assignedSession: 'task-worker:parent-1',
      workerSessionKey: 'task-worker:parent-1',
      retryCount: 0,
      maxRetries: 1,
      escalationRequired: true,
      artifacts: [],
      children: ['child-a', 'child-b'],
      events: [],
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
    };

    const childA: any = {
      id: 'child-a',
      source: 'operator',
      text: 'child-a',
      repoId: 'repo-fanout-retry',
      parentTaskId: 'parent-1',
      status: 'done',
      state: 'done',
      assignedSession: 'task-worker:child-a',
      workerSessionKey: 'task-worker:child-a',
      retryCount: 0,
      maxRetries: 1,
      escalationRequired: false,
      artifacts: [],
      children: [],
      events: [],
      createdAt: now,
      updatedAt: now,
      finishedAt: now,
    };

    const childB: any = {
      ...childA,
      id: 'child-b',
      parentTaskId: 'parent-1',
      status: 'done',
      state: 'done',
    };

    const store = (orchestrator as any).tasks as Map<string, any>;
    store.set(parent.id, parent);
    store.set(childA.id, childA);
    store.set(childB.id, childB);

    expect(() => (orchestrator as any).updateParentState(childB)).not.toThrow();
    expect((orchestrator as any).getTask(parent.id)?.status).toBe('done');

    childA.status = 'failed';
    childA.state = 'failed';
    expect(() => (orchestrator as any).updateParentState(childA)).not.toThrow();
    expect((orchestrator as any).getTask(parent.id)?.status).toBe('failed');
  });
  it('completes fanout parent when all children finish', async () => {
    const repoDir = path.join(sandbox, 'repo-fanout');
    await initGitRepo(repoDir);

    const orchestrator = new TaskOrchestrator(baseConfig(sandbox, { TASK_MAX_CONCURRENCY: 2 }));
    orchestrators.push(orchestrator);
    await orchestrator.initialize();

    await orchestrator.registerRepo({
      id: 'repo-fanout',
      path: repoDir,
      defaultBranch: 'main',
      remote: 'origin',
      isDefault: true,
    });

    const parent = await orchestrator.submitTask({
      text: 'Parent task',
      repoId: 'repo-fanout',
      source: 'operator',
      fanout: ['child task one', 'child task two'],
    });

    await waitFor(() => {
      const current = orchestrator.getTask(parent.id);
      return Boolean(current && (current.state === 'done' || current.state === 'failed'));
    }, 15000);

    const finalParent = orchestrator.getTask(parent.id);
    expect(finalParent?.children.length).toBe(2);
    expect(finalParent?.state).toBe('done');
  }, 20000);
});

describe('worktree stale cleanup', () => {
  let sandbox = '';

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-worktree-cleanup-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('removes stale worktree directories', async () => {
    const root = path.join(sandbox, 'worktrees');
    const manager = new WorktreeManager(root);
    await manager.initialize();

    const stale = path.join(root, 'stale-dir');
    const fresh = path.join(root, 'fresh-dir');
    await mkdir(stale, { recursive: true });
    await mkdir(fresh, { recursive: true });

    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    await manager.cleanupStale(1);

    expect(await exists(stale)).toBe(false);
    expect(await exists(fresh)).toBe(true);
  });
});

describe('bridge signature matrix', () => {
  it('enforces signature only when shared secret is configured', () => {
    const openBridge = new InboundBridge('');
    const openResult = openBridge.accept({
      messageId: 'open-1',
      source: 'github',
      type: 'push',
      payload: {},
      timestamp: Date.now(),
    });
    expect(openResult.status).toBe('accepted');

    const secureBridge = new InboundBridge('secret');
    const denied = secureBridge.accept(
      {
        messageId: 'secure-1',
        source: 'github',
        type: 'push',
        payload: {},
        timestamp: Date.now(),
      },
      'wrong',
    );
    expect(denied.status).toBe('rejected');
    expect(denied.ack).toBe(false);

    const allowed = secureBridge.accept(
      {
        messageId: 'secure-2',
        source: 'github',
        type: 'push',
        payload: {},
        timestamp: Date.now(),
      },
      'secret',
    );
    expect(allowed.status).toBe('accepted');
    expect(allowed.ack).toBe(true);
  });
});

describe('security audit retention + redaction', () => {
  let sandbox = '';

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-security-audit-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('prunes old session directories and redacts common secrets', async () => {
    const dataDir = path.join(sandbox, 'data');
    const oldSession = path.join(dataDir, 'sessions', 'old-session');
    const recentSession = path.join(dataDir, 'sessions', 'recent-session');

    await mkdir(oldSession, { recursive: true });
    await mkdir(recentSession, { recursive: true });

    await writeFile(path.join(oldSession, 'log.jsonl'), '{"token":"sk-old-secret-1234567890"}\n', 'utf8');
    await writeFile(path.join(recentSession, 'log.jsonl'), '{"token":"xoxb-recent-secret-1234567890"}\n', 'utf8');

    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(oldSession, tenDaysAgo, tenDaysAgo);

    const audit = await runSecurityAudit(
      baseConfig(sandbox, {
        DATA_DIR: dataDir,
        SESSION_LOG_RETENTION_DAYS: 1,
      }),
    );

    expect(audit.ok).toBe(true);
    expect(await exists(oldSession)).toBe(false);

    const redacted = await readFile(path.join(recentSession, 'log.jsonl'), 'utf8');
    expect(redacted.includes('[REDACTED]')).toBe(true);
    expect(redacted.includes('xoxb-')).toBe(false);
  });
});
