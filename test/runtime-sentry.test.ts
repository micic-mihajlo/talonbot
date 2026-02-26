import http from 'node:http';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

const readHttpBody = async <T>(res: http.IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
};

const requestHttp = <T>(
  port: number,
  route: string,
  init: {
    method?: 'GET' | 'POST';
    token?: string;
  } = {},
): Promise<{ statusCode: number; payload: T }> => {
  const method = init.method ?? 'GET';
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (init.token) {
      headers.Authorization = `Bearer ${init.token}`;
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
        try {
          const payload = await readHttpBody<T>(res);
          resolve({ statusCode: res.statusCode || 0, payload });
        } catch (error) {
          reject(error);
        }
      },
    );
    req.on('error', reject);
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

describe('runtime sentry endpoint', () => {
  let sandbox = '';
  let controlPlane: ControlPlane;
  let httpServer: http.Server;
  let httpPort = 0;
  const token = 'runtime-sentry-auth-token-123456';

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-runtime-sentry-'));
    await mkdir(path.join(sandbox, 'data'), { recursive: true });
    const config = buildConfig(sandbox, token);
    controlPlane = new ControlPlane(config, () => createEngine());
    await controlPlane.initialize();
    httpServer = await createHttpServer(controlPlane, config, 0, undefined as any, {
      sentry: {
        getStatus: () => ({
          scans: 5,
          trackedTasks: 2,
          incidents: 1,
          lastIncidentAt: '2026-01-01T00:00:00.000Z',
        }),
        listIncidents: () => [
          {
            taskId: 'task-1',
            repoId: 'repo',
            state: 'failed',
            detectedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      } as any,
    });
    httpPort = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    controlPlane.stop();
    await rm(sandbox, { recursive: true, force: true });
  });

  it('serves sentry status behind auth', async () => {
    const denied = await requestHttp<{ error: string }>(httpPort, '/sentry/status');
    expect(denied.statusCode).toBe(401);

    const allowed = await requestHttp<{
      status: { incidents: number };
      incidents: Array<{ taskId: string }>;
    }>(httpPort, '/sentry/status', { token });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.payload.status.incidents).toBe(1);
    expect(allowed.payload.incidents[0]?.taskId).toBe('task-1');
  });
});
