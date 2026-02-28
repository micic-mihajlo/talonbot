import { afterEach, describe, expect, it } from 'vitest';
import { ProcessEngine } from '../src/engine/process.js';
import type { EngineInput } from '../src/engine/types.js';

const buildInput = (): EngineInput => ({
  sessionKey: 'session-env-test',
  route: 'dispatch:env-test',
  text: 'test',
  senderId: 'tester',
  metadata: {},
  contextLines: [],
  rawEvent: {
    id: 'evt-env-test',
    source: 'socket',
    sourceChannelId: 'socket-env-test',
    sourceMessageId: 'msg-env-test',
    senderId: 'tester',
    senderName: 'tester',
    senderIsBot: false,
    text: 'test',
    mentionsBot: true,
    attachments: [],
    metadata: {},
    receivedAt: new Date().toISOString(),
  },
  recentAttachments: [],
});

const ORIGINAL_PI_SKIP_VERSION_CHECK = process.env.PI_SKIP_VERSION_CHECK;

afterEach(() => {
  if (ORIGINAL_PI_SKIP_VERSION_CHECK === undefined) {
    delete process.env.PI_SKIP_VERSION_CHECK;
  } else {
    process.env.PI_SKIP_VERSION_CHECK = ORIGINAL_PI_SKIP_VERSION_CHECK;
  }
});

describe('process engine env passthrough', () => {
  it('passes PI_* environment variables into process-mode execution', async () => {
    process.env.PI_SKIP_VERSION_CHECK = '1';
    const engine = new ProcessEngine('node', '-e "process.stdout.write(process.env.PI_SKIP_VERSION_CHECK || \'\')"', 5000, process.cwd());

    const output = await engine.complete(buildInput());

    expect(output.text).toBe('1');
  });
});
