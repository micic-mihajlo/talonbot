import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SentryAgent } from '../src/orchestration/sentry-agent.js';
import type { TaskRecord } from '../src/orchestration/types.js';

const task = (overrides: Partial<TaskRecord>): TaskRecord => {
  const base: TaskRecord = {
    id: 'task-1',
    source: 'operator',
    text: 'task',
    repoId: 'repo',
    status: 'done',
    state: 'done',
    assignedSession: 'task-worker:task-1',
    workerSessionKey: 'worker-1',
    retryCount: 0,
    maxRetries: 1,
    escalationRequired: false,
    artifacts: [],
    children: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  };
  const merged = {
    ...base,
    ...overrides,
  } as TaskRecord;
  if (overrides.state && !overrides.status) {
    merged.status = overrides.state;
  }
  if (overrides.status && !overrides.state) {
    merged.state = overrides.status;
  }
  return merged;
};

describe('sentry agent', () => {
  let sandbox = '';

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-sentry-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('detects escalated failed tasks and persists incidents once', async () => {
    const tasks: TaskRecord[] = [
      task({ id: 'task-ok', state: 'done' }),
      task({
        id: 'task-failed',
        state: 'failed',
        escalationRequired: true,
        error: 'build failed',
        updatedAt: new Date().toISOString(),
      }),
    ];

    let callbacks = 0;
    const stateFile = path.join(sandbox, 'incidents.jsonl');
    const sentry = new SentryAgent({
      pollMs: 1000,
      stateFile,
      listTasks: () => tasks,
      onEscalation: async () => {
        callbacks += 1;
      },
    });

    await sentry.initialize();
    await sentry.scan();
    await sentry.scan();

    const status = sentry.getStatus();
    expect(status.incidents).toBe(1);
    expect(callbacks).toBe(1);

    const raw = await readFile(stateFile, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
    expect(raw).toContain('"taskId":"task-failed"');
  });

  it('loads previous incident state and avoids duplicate alerts on restart', async () => {
    const stateFile = path.join(sandbox, 'incidents.jsonl');
    const tasks: TaskRecord[] = [
      task({
        id: 'task-restart',
        state: 'blocked',
        escalationRequired: true,
        error: 'checks failed',
      }),
    ];

    const first = new SentryAgent({
      pollMs: 1000,
      stateFile,
      listTasks: () => tasks,
    });
    await first.initialize();
    await first.scan();

    const second = new SentryAgent({
      pollMs: 1000,
      stateFile,
      listTasks: () => tasks,
    });
    await second.initialize();
    await second.scan();

    expect(second.getStatus().incidents).toBe(1);
  });
});
