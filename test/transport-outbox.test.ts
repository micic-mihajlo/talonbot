import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { TransportOutbox } from '../src/transports/outbox.js';

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, intervalMs = 20) => {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for condition');
};

describe('transport outbox', () => {
  let sandbox = '';

  afterEach(async () => {
    if (sandbox) {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('retries failed messages and marks poison after max retries', async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-outbox-'));

    let attempts = 0;
    const outbox = new TransportOutbox<{ text: string }>(
      path.join(sandbox, 'outbox.json'),
      async () => {
        attempts += 1;
        throw new Error('simulated_send_failure');
      },
      50,
      100,
      2,
      {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    );

    await outbox.initialize();
    await outbox.enqueue({
      idempotencyKey: 'msg-1',
      payload: { text: 'hello' },
    });

    await waitFor(() => outbox.list().some((record) => record.status === 'poison'), 4000);
    expect(attempts).toBeGreaterThanOrEqual(3);
    await outbox.stop();
  });

  it('dedupes idempotent enqueues and marks sent on success', async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-outbox-'));

    let sends = 0;
    const outbox = new TransportOutbox<{ text: string }>(
      path.join(sandbox, 'outbox.json'),
      async () => {
        sends += 1;
      },
      50,
      100,
      2,
      {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    );

    await outbox.initialize();
    await outbox.enqueue({
      idempotencyKey: 'msg-1',
      payload: { text: 'hello' },
    });
    await outbox.enqueue({
      idempotencyKey: 'msg-1',
      payload: { text: 'hello' },
    });

    await waitFor(() => outbox.list().some((record) => record.status === 'sent'), 3000);
    expect(sends).toBe(1);
    expect(outbox.list().length).toBe(1);
    await outbox.stop();
  });
});
