import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { SessionEngine } from '../src/engine/session.js';
import { buildEngine } from '../src/engine/index.js';
import { ProcessEngine } from '../src/engine/process.js';
import type { EngineInput } from '../src/engine/types.js';
import { TaskOrchestrator } from '../src/orchestration/task-orchestrator.js';
import { config as defaultConfig } from '../src/config.js';
import type { AppConfig } from '../src/config.js';

class MockSocket extends EventEmitter {
  writes: string[] = [];

  setEncoding(_encoding: string) {}

  write(chunk: string) {
    this.writes.push(chunk);
    this.emit('write', chunk);
    return true;
  }

  end() {
    this.emit('close');
    return this;
  }

  destroy() {
    this.emit('close');
    return this;
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 10000, intervalMs = 50) => {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('timed out waiting for condition');
};

const buildInput = (sessionKey: string, text: string): EngineInput => ({
  sessionKey,
  route: `task:${sessionKey}`,
  text,
  senderId: 'tester',
  metadata: {},
  contextLines: [],
  rawEvent: {
    id: `evt-${Date.now()}`,
    source: 'socket',
    sourceChannelId: sessionKey,
    sourceMessageId: `msg-${Date.now()}`,
    senderId: 'tester',
    senderName: 'tester',
    senderIsBot: false,
    text,
    mentionsBot: true,
    attachments: [],
    metadata: {},
    receivedAt: new Date().toISOString(),
  },
  recentAttachments: [],
});

const initGitRepo = async (repoDir: string) => {
  await mkdir(repoDir, { recursive: true });
  await writeFile(path.join(repoDir, 'README.md'), '# session mode repo\n', 'utf8');

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
};

const baseConfig = (sandbox: string): AppConfig => ({
  ...defaultConfig,
  DATA_DIR: path.join(sandbox, 'data'),
  CONTROL_SOCKET_PATH: path.join(sandbox, 'data', 'control.sock'),
  WORKTREE_ROOT_DIR: path.join(sandbox, 'worktrees'),
  REPO_ROOT_DIR: path.join(sandbox, 'workspace'),
  RELEASE_ROOT_DIR: path.join(sandbox, 'release-root'),
  ENGINE_MODE: 'session',
  ENGINE_COMMAND: 'sh',
  ENGINE_ARGS: '-lc "echo ignored"',
  ENGINE_CWD: path.join(sandbox, 'engine-cwd'),
  TASK_MAX_CONCURRENCY: 1,
  WORKER_MAX_RETRIES: 1,
  TASK_AUTOCLEANUP: true,
  TASK_AUTO_COMMIT: false,
  TASK_AUTO_PR: false,
  STARTUP_INTEGRITY_MODE: 'warn',
  CONTROL_AUTH_TOKEN: 'a-very-long-control-token-for-tests-1234567890',
});

describe('session engine socket rpc', () => {
  it('completes a turn from subscribe/send/get_message flow', async () => {
    const commands: string[] = [];
    const mockSocket = new MockSocket();

    mockSocket.on('write', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const command = JSON.parse(line) as { type: string; id?: string };
        commands.push(command.type);

        if (command.type === 'subscribe') {
          mockSocket.emit(
            'data',
            `${JSON.stringify({ type: 'response', command: 'subscribe', success: true, id: command.id })}\n`,
          );
          continue;
        }

        if (command.type === 'send') {
          mockSocket.emit(
            'data',
            `${JSON.stringify({ type: 'response', command: 'send', success: true, id: command.id })}\n`,
          );
          mockSocket.emit('data', `${JSON.stringify({ type: 'event', event: 'turn_end', data: { turnIndex: 1 } })}\n`);
          continue;
        }

        if (command.type === 'get_message') {
          mockSocket.emit(
            'data',
            `${JSON.stringify({
              type: 'response',
              command: 'get_message',
              success: true,
              id: command.id,
              data: {
                message: {
                  role: 'assistant',
                  content: 'session-engine-response',
                },
              },
            })}\n`,
          );
        }
      }
    });

    const connector = () => {
      queueMicrotask(() => {
        mockSocket.emit('connect');
      });
      return mockSocket as unknown as Socket;
    };

    const engine = new SessionEngine('/tmp/mock-control.sock', 3000, 2, connector);
    const result = await engine.complete(buildInput('session-lifecycle', 'run task'));

    expect(result.text).toBe('session-engine-response');
    expect(commands).toEqual(['subscribe', 'send', 'get_message']);
  });

  it('retries after transient connection close and succeeds on next attempt', async () => {
    const attempts: MockSocket[] = [];
    let connectCount = 0;

    const connector = () => {
      connectCount += 1;
      const socket = new MockSocket();
      attempts.push(socket);

      if (connectCount === 1) {
        queueMicrotask(() => {
          socket.emit('error', new Error('transient socket failure'));
        });
        return socket as unknown as Socket;
      }

      socket.on('write', (chunk: string) => {
        for (const line of chunk.split('\n').filter(Boolean)) {
          const command = JSON.parse(line) as { type: string; id?: string };
          if (command.type === 'subscribe') {
            socket.emit(
              'data',
              `${JSON.stringify({ type: 'response', command: 'subscribe', success: true, id: command.id })}\n`,
            );
            continue;
          }
          if (command.type === 'send') {
            socket.emit('data', `${JSON.stringify({ type: 'response', command: 'send', success: true, id: command.id })}\n`);
            socket.emit('data', `${JSON.stringify({ type: 'event', event: 'turn_end', data: { turnIndex: 1 } })}\n`);
            continue;
          }
          if (command.type === 'get_message') {
            socket.emit(
              'data',
              `${JSON.stringify({
                type: 'response',
                command: 'get_message',
                success: true,
                id: command.id,
                data: { message: { role: 'assistant', content: 'recovered-response' } },
              })}\n`,
            );
          }
        }
      });

      queueMicrotask(() => {
        socket.emit('connect');
      });
      return socket as unknown as Socket;
    };

    const engine = new SessionEngine('/tmp/mock-control.sock', 3000, 2, connector);
    const result = await engine.complete(buildInput('session-retry', 'retry turn'));

    expect(result.text).toBe('recovered-response');
    expect(attempts.length).toBe(2);
  });
});

describe('session engine mode integration', () => {
  let sandbox = '';
  let orchestrator: TaskOrchestrator | null = null;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-session-mode-'));
  });

  afterEach(async () => {
    await orchestrator?.stop();
    await rm(sandbox, { recursive: true, force: true });
  });

  it('routes dispatch target to process engine and orchestrator target to session engine', () => {
    const config = baseConfig(sandbox);
    const dispatchEngine = buildEngine(config, 'dispatch');
    const orchestratorEngine = buildEngine(config, 'orchestrator');

    expect(dispatchEngine).toBeInstanceOf(ProcessEngine);
    expect(orchestratorEngine).toBeInstanceOf(SessionEngine);
  });

  it('propagates session transport failures into task retry + failed state', async () => {
    const repoDir = path.join(sandbox, 'repo-failure');
    await initGitRepo(repoDir);

    orchestrator = new TaskOrchestrator(baseConfig(sandbox));
    await orchestrator.initialize();
    await orchestrator.registerRepo({
      id: 'repo-failure',
      path: repoDir,
      defaultBranch: 'main',
      remote: 'origin',
      isDefault: true,
    });

    const task = await orchestrator.submitTask({
      text: 'This should fail without a live control socket',
      repoId: 'repo-failure',
      source: 'operator',
    });

    await waitFor(() => orchestrator?.getTask(task.id)?.state === 'failed', 15000);

    const failed = orchestrator.getTask(task.id);
    expect(failed?.state).toBe('failed');
    expect(failed?.retryCount).toBe(2);
    expect(failed?.escalationRequired).toBe(true);
    expect(failed?.events.some((event) => event.kind === 'retry_scheduled')).toBe(true);
  });
});
