import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { InboundBridge } from '../src/bridge/inbound-bridge.js';
import { ReleaseManager } from '../src/ops/release-manager.js';
import { TaskOrchestrator } from '../src/orchestration/task-orchestrator.js';
import { config as defaultConfig } from '../src/config.js';
import type { AppConfig } from '../src/config.js';

const waitFor = async (predicate: () => boolean, timeoutMs = 10000, intervalMs = 50) => {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for condition');
};

describe('bridge envelope handling', () => {
  it('accepts valid envelopes, dedupes, and rejects bad signatures', () => {
    const bridge = new InboundBridge('shared-secret', 10000);

    const first = bridge.accept(
      {
        messageId: 'm1',
        source: 'github',
        type: 'pull_request',
        payload: { title: 'test' },
        timestamp: Date.now(),
      },
      'shared-secret',
    );
    expect(first.status).toBe('accepted');
    expect(first.ack).toBe(true);

    const duplicate = bridge.accept(
      {
        messageId: 'm1',
        source: 'github',
        type: 'pull_request',
        payload: { title: 'test' },
        timestamp: Date.now(),
      },
      'shared-secret',
    );
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.ack).toBe(true);

    const poison = bridge.accept({ not: 'envelope' }, 'shared-secret');
    expect(poison.status).toBe('poison');
    expect(poison.ack).toBe(true);

    const rejected = bridge.accept(
      {
        messageId: 'm2',
        source: 'github',
        type: 'push',
        payload: {},
        timestamp: Date.now(),
      },
      'bad-signature',
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.ack).toBe(false);
  });
});

describe('release snapshot + integrity', () => {
  let sandbox = '';

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-release-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('creates snapshots, activates current, and validates integrity', async () => {
    const sourceDir = path.join(sandbox, 'source');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'file.txt'), 'hello release', 'utf8');
    await mkdir(path.join(sourceDir, '.git'), { recursive: true });
    await writeFile(path.join(sourceDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const releases = path.join(sandbox, 'releases-root');
    const manager = new ReleaseManager(releases);
    await manager.initialize();

    const snapshot = await manager.createSnapshot(sourceDir);
    expect(snapshot.sha).toHaveLength(12);

    const activePath = await manager.activate(snapshot.sha);
    expect(activePath.endsWith(snapshot.sha)).toBe(true);

    const status = await manager.status();
    expect(status.current).toContain(snapshot.sha);

    const pass = await manager.integrityCheck('strict');
    expect(pass.ok).toBe(true);

    const activeFile = path.join(activePath, 'file.txt');
    await writeFile(activeFile, 'tampered', 'utf8');

    const fail = await manager.integrityCheck('strict');
    expect(fail.ok).toBe(false);
    expect(fail.mismatches.length).toBeGreaterThan(0);
  });
});

describe('task orchestration flow', () => {
  let sandbox = '';

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-orch-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('runs queued tasks in worker worktrees and completes them', async () => {
    const repoDir = path.join(sandbox, 'repo');
    await mkdir(repoDir, { recursive: true });
    await writeFile(path.join(repoDir, 'README.md'), '# Repo\n', 'utf8');

    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

    const config: AppConfig = {
      ...defaultConfig,
      DATA_DIR: path.join(sandbox, 'data'),
      WORKTREE_ROOT_DIR: path.join(sandbox, 'worktrees'),
      REPO_ROOT_DIR: path.join(sandbox, 'workspace'),
      TASK_MAX_CONCURRENCY: 1,
      WORKER_MAX_RETRIES: 0,
      TASK_AUTOCLEANUP: false,
      TASK_AUTO_COMMIT: false,
      TASK_AUTO_PR: false,
      ENGINE_MODE: 'mock',
      CONTROL_SOCKET_PATH: path.join(sandbox, 'data', 'control.sock'),
      RELEASE_ROOT_DIR: path.join(sandbox, 'release-root'),
      STARTUP_INTEGRITY_MODE: 'warn',
    };

    const orchestrator = new TaskOrchestrator(config);
    await orchestrator.initialize();

    await orchestrator.registerRepo({
      id: 'repo',
      path: repoDir,
      defaultBranch: 'main',
      remote: 'origin',
      isDefault: true,
    });

    const task = await orchestrator.submitTask({
      text: 'Prepare implementation notes and report status.',
      repoId: 'repo',
      source: 'operator',
    });

    await waitFor(() => {
      const current = orchestrator.getTask(task.id);
      return Boolean(current && (current.state === 'done' || current.state === 'failed'));
    });

    const completed = orchestrator.getTask(task.id);
    expect(completed?.state).toBe('done');
    expect(completed?.artifact?.summary?.length || 0).toBeGreaterThan(0);
    expect(completed?.artifact?.worktreePath).toContain(path.join(sandbox, 'worktrees'));
  });
});
