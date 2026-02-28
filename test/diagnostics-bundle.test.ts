import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { createDiagnosticsBundle } from '../src/diagnostics/bundle.js';
import { config as defaultConfig } from '../src/config.js';

describe('diagnostics bundle', () => {
  let sandbox = '';

  afterEach(async () => {
    if (sandbox) {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('includes worker runtime and orchestration health artifacts when tasks service is configured', async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-diagnostics-bundle-'));

    const bundle = await createDiagnosticsBundle({
      outputDir: sandbox,
      config: defaultConfig,
      control: {
        listSessions: () => [{ sessionKey: 'discord:ops:main' }],
      } as any,
      tasks: {
        listTasks: () => [{ id: 'task-1', status: 'running' }],
        listRepos: () => [{ id: 'repo-1', path: '/tmp/repo-1' }],
        getWorkerRuntimeSnapshot: async () => ({
          runtime: 'tmux',
          sessionPrefix: 'dev-agent',
          activeTasks: [{ taskId: 'task-1', repoId: 'repo-1', status: 'running', session: 'dev-agent-repo-1-task-1' }],
          activeSessions: ['dev-agent-repo-1-task-1'],
          tmuxSessions: ['dev-agent-repo-1-task-1', 'dev-agent-orphan'],
          orphanedSessions: ['dev-agent-orphan'],
        }),
        getHealthStatus: async () => ({
          status: 'degraded',
          checkedAt: new Date().toISOString(),
          issues: [{ code: 'orphaned_worker_slot', message: 'orphaned worker', severity: 'warn' }],
          metrics: {
            totalTasks: 1,
            queued: 0,
            running: 1,
            done: 0,
            failed: 0,
            blocked: 0,
            cancelled: 0,
            staleQueued: 0,
            staleRunning: 0,
            staleWorktrees: 0,
            orphanedWorkerSlots: 1,
          },
        }),
      } as any,
    });

    expect(bundle.files).toContain('workers.json');
    expect(bundle.files).toContain('orchestration-health.json');

    const workers = JSON.parse(await readFile(path.join(bundle.bundleDir, 'workers.json'), 'utf8')) as { runtime: string };
    expect(workers.runtime).toBe('tmux');

    const orchestration = JSON.parse(await readFile(path.join(bundle.bundleDir, 'orchestration-health.json'), 'utf8')) as {
      status: string;
      issues: Array<{ code: string }>;
    };
    expect(orchestration.status).toBe('degraded');
    expect(orchestration.issues[0]?.code).toBe('orphaned_worker_slot');
  });
});
