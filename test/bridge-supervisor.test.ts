import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeSupervisor } from '../src/bridge/supervisor.js';

const waitFor = async (predicate: () => boolean, timeoutMs = 10000, intervalMs = 25) => {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for condition');
};

describe('bridge supervisor', () => {
  let sandbox = '';
  const supervisors: BridgeSupervisor[] = [];

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-bridge-supervisor-'));
  });

  afterEach(async () => {
    for (const supervisor of supervisors) {
      supervisor.stop();
    }
    supervisors.length = 0;
    await rm(sandbox, { recursive: true, force: true });
  });

  it('retries failed dispatches and eventually acks', async () => {
    let attempts = 0;
    const supervisor = new BridgeSupervisor({
      sharedSecret: 'bridge-secret',
      stateFile: path.join(sandbox, 'bridge-state.json'),
      retryBaseMs: 10,
      retryMaxMs: 50,
      maxRetries: 5,
      onDispatch: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('transient_failure');
        }
        return { taskId: 'task-123' };
      },
    });
    supervisors.push(supervisor);
    await supervisor.initialize();

    const accepted = await supervisor.accept(
      {
        messageId: 'm-retry-1',
        source: 'github',
        type: 'push',
        payload: { text: 'hello' },
        timestamp: Date.now(),
      },
      'bridge-secret',
    );

    expect(accepted.status).toBe('queued');
    await waitFor(() => supervisor.getHealth().acked === 1, 5000);

    const record = supervisor.listRecords().find((item) => item.messageId === 'm-retry-1');
    expect(record?.state).toBe('acked');
    expect(record?.attempts).toBe(2);
    expect(record?.taskId).toBe('task-123');
  });

  it('marks messages as poison after max retries', async () => {
    const supervisor = new BridgeSupervisor({
      sharedSecret: 'bridge-secret',
      stateFile: path.join(sandbox, 'bridge-state-poison.json'),
      retryBaseMs: 10,
      retryMaxMs: 50,
      maxRetries: 1,
      onDispatch: async () => {
        throw new Error('hard_failure');
      },
    });
    supervisors.push(supervisor);
    await supervisor.initialize();

    await supervisor.accept(
      {
        messageId: 'm-poison-1',
        source: 'github',
        type: 'pull_request',
        payload: {},
        timestamp: Date.now(),
      },
      'bridge-secret',
    );

    await waitFor(() => supervisor.getHealth().poison === 1, 5000);

    const record = supervisor.listRecords().find((item) => item.messageId === 'm-poison-1');
    expect(record?.state).toBe('poison');
    expect(record?.attempts).toBe(2);
  });

  it('handles rejected signatures and duplicate ids', async () => {
    const supervisor = new BridgeSupervisor({
      sharedSecret: 'bridge-secret',
      stateFile: path.join(sandbox, 'bridge-state-dup.json'),
      retryBaseMs: 10,
      retryMaxMs: 50,
      maxRetries: 2,
      onDispatch: async () => ({ taskId: 'task-1' }),
    });
    supervisors.push(supervisor);
    await supervisor.initialize();

    const rejected = await supervisor.accept(
      {
        messageId: 'm-sec-1',
        source: 'github',
        type: 'push',
        payload: {},
        timestamp: Date.now(),
      },
      'wrong-secret',
    );

    expect(rejected.status).toBe('rejected');
    expect(rejected.ack).toBe(false);

    const first = await supervisor.accept(
      {
        messageId: 'm-sec-2',
        source: 'github',
        type: 'push',
        payload: {},
        timestamp: Date.now(),
      },
      'bridge-secret',
    );
    expect(first.status).toBe('queued');

    await waitFor(() => supervisor.getHealth().acked === 1, 5000);

    const duplicate = await supervisor.accept(
      {
        messageId: 'm-sec-2',
        source: 'github',
        type: 'push',
        payload: {},
        timestamp: Date.now(),
      },
      'bridge-secret',
    );
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.ack).toBe(true);
  });
});
