import http from 'node:http';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { ControlPlane } from '../src/control/daemon.js';
import { createHttpServer } from '../src/runtime/http.js';
import { config as defaultConfig } from '../src/config.js';
import type { AppConfig } from '../src/config.js';
import type { EngineInput } from '../src/engine/types.js';

const createEngine = () => ({
  complete: async (input: EngineInput) => ({ text: `engine:${input.text}` }),
  ping: async () => true,
});

const requestHttp = <T>(
  port: number,
  route: string,
  init: {
    method?: 'GET' | 'POST';
    token?: string;
    body?: unknown;
  } = {},
): Promise<{ statusCode: number; payload: T }> => {
  const method = init.method ?? 'GET';
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (init.token) {
      headers.Authorization = `Bearer ${init.token}`;
    }
    if (init.body) {
      headers['content-type'] = 'application/json';
    }

    const req = http.request(
      {
        method,
        hostname: '127.0.0.1',
        port,
        path: route,
        headers,
      },
      async (res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of res) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
        resolve({ statusCode: res.statusCode || 0, payload });
      },
    );

    req.on('error', reject);
    if (init.body) {
      req.write(JSON.stringify(init.body));
    }
    req.end();
  });
};

const buildConfig = (sandbox: string, token: string): AppConfig => ({
  ...defaultConfig,
  DATA_DIR: path.join(sandbox, 'data'),
  CONTROL_SOCKET_PATH: path.join(sandbox, 'control.sock'),
  CONTROL_HTTP_PORT: 0,
  CONTROL_AUTH_TOKEN: token,
  ENGINE_MODE: 'mock',
});

describe('runtime worker endpoints', () => {
  let sandbox = '';
  let token = '';
  let control: ControlPlane;
  let httpServer: http.Server;
  let httpPort = 0;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-runtime-workers-'));
    token = 'runtime-workers-token-12345678901234567890';
    const config = buildConfig(sandbox, token);

    control = new ControlPlane(config, () => createEngine());
    await control.initialize();

    const tasksStub = {
      getWorkerRuntimeSnapshot: async () => ({
        runtime: 'tmux',
        sessionPrefix: 'dev-agent',
        activeTasks: [
          {
            taskId: 'task-1',
            repoId: 'repo-1',
            status: 'running',
            session: 'dev-agent-repo-1-task-1',
          },
        ],
        activeSessions: ['dev-agent-repo-1-task-1'],
        tmuxSessions: ['dev-agent-repo-1-task-1', 'dev-agent-orphan-2'],
        orphanedSessions: ['dev-agent-orphan-2'],
      }),
      cleanupOrphanedWorkers: async () => ({
        runtime: 'tmux',
        scanned: 2,
        kept: ['dev-agent-repo-1-task-1'],
        killed: ['dev-agent-orphan-2'],
      }),
      stopWorkerSession: async (session: string) => ({
        session,
        taskId: 'task-1',
        cancelRequested: true,
        tmuxStopped: true,
      }),
    };

    httpServer = await createHttpServer(control, config, 0, undefined as any, {
      tasks: tasksStub as any,
    });
    httpPort = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    control.stop();
    await rm(sandbox, { recursive: true, force: true });
  });

  it('enforces auth and serves worker runtime lifecycle endpoints', async () => {
    const denied = await requestHttp<{ error: string }>(httpPort, '/workers');
    expect(denied.statusCode).toBe(401);
    expect(denied.payload.error).toBe('unauthorized');

    const listed = await requestHttp<{
      runtime: string;
      activeSessions: string[];
      tmuxSessions: string[];
      orphanedSessions: string[];
    }>(httpPort, '/workers', { token });
    expect(listed.statusCode).toBe(200);
    expect(listed.payload.runtime).toBe('tmux');
    expect(listed.payload.activeSessions).toContain('dev-agent-repo-1-task-1');
    expect(listed.payload.orphanedSessions).toContain('dev-agent-orphan-2');

    const cleanup = await requestHttp<{ killed: string[]; kept: string[] }>(httpPort, '/workers/cleanup', {
      method: 'POST',
      token,
    });
    expect(cleanup.statusCode).toBe(200);
    expect(cleanup.payload.killed).toEqual(['dev-agent-orphan-2']);
    expect(cleanup.payload.kept).toEqual(['dev-agent-repo-1-task-1']);

    const stopped = await requestHttp<{ session: string; cancelRequested: boolean; tmuxStopped: boolean }>(
      httpPort,
      '/workers/dev-agent-repo-1-task-1/stop',
      {
        method: 'POST',
        token,
      },
    );
    expect(stopped.statusCode).toBe(200);
    expect(stopped.payload.session).toBe('dev-agent-repo-1-task-1');
    expect(stopped.payload.cancelRequested).toBe(true);
    expect(stopped.payload.tmuxStopped).toBe(true);
  });
});
