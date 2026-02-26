import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';

import { ControlPlane } from '../src/control/daemon.js';
import { createHttpServer } from '../src/runtime/http.js';
import { createSocketServer } from '../src/runtime/socket.js';
import { config as defaultConfig } from '../src/config.js';
import type { AppConfig, EngineInput } from '../src/shared/protocol.js';

const createEngine = () => ({
  complete: async (input: EngineInput) => ({ text: `engine:${input.text}` }),
  ping: async () => true,
});

const buildTestConfig = (dataDir: string, controlSocketPath: string, httpPort = 0): AppConfig => ({
  ...defaultConfig,
  DATA_DIR: dataDir,
  CONTROL_SOCKET_PATH: controlSocketPath,
  CONTROL_HTTP_PORT: httpPort,
  ENGINE_MODE: 'mock',
});

const createWorkingDirectory = async () => {
  const workingDirectory = path.join('/tmp', `tb-${Math.random().toString(36).slice(2, 7)}`);
  await rm(workingDirectory, { recursive: true, force: true });
  await mkdir(workingDirectory, { recursive: true });
  return workingDirectory;
};

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
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<{ statusCode: number; payload: T }> => {
  const method = init.method ?? 'GET';
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(init.headers || {}) };
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
        try {
          const payload = await readHttpBody<T>(res);
          resolve({ statusCode: res.statusCode || 0, payload });
        } catch (error) {
          reject(error);
        }
      },
    );
    req.on('error', reject);
    if (init.body) {
      req.write(JSON.stringify(init.body));
    }
    req.end();
  });
};

const sendSocket = (socketPath: string, payload: unknown): Promise<unknown> => {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    const cleanup = (error?: unknown) => {
      client.end();
      if (error) {
        reject(error);
      }
    };

    let buffer = '';
    const done = (value: unknown) => {
      client.removeAllListeners();
      client.end();
      resolve(value);
    };

    client.on('connect', () => {
      client.write(`${JSON.stringify(payload)}\n`);
    });

    client.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString();
      const lines = buffer.split('\n');
      if (lines.length > 1) {
        done(JSON.parse(lines[0]));
      }
    });

    client.on('error', cleanup);
  });
};

describe('HTTP control runtime', () => {
  let workingDirectory = '';
  let controlPlane: ControlPlane;
  let httpServer: http.Server;
  let httpPort = 0;

  beforeEach(async () => {
    workingDirectory = await createWorkingDirectory();
    const socketPath = path.join(workingDirectory, 'control.sock');
    controlPlane = new ControlPlane(buildTestConfig(workingDirectory, socketPath), () => createEngine());
    await controlPlane.initialize();
    httpServer = await createHttpServer(controlPlane, buildTestConfig(workingDirectory, socketPath), 0, undefined as any);
    httpPort = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    controlPlane.stop();
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it('serves health, dispatch, and alias endpoints', async () => {
    const health = await requestHttp<{ status: string }>(httpPort, '/health');
    expect(health.statusCode).toBe(200);
    expect(health.payload.status).toBe('ok');

    const dispatch = await requestHttp<{ accepted: boolean; sessionKey?: string }>(httpPort, '/dispatch', {
      method: 'POST',
      body: {
        source: 'discord',
        channelId: 'engineering',
        text: 'spin up baseline',
      },
    });
    expect(dispatch.statusCode).toBe(200);
    expect(dispatch.payload.accepted).toBe(true);
    const sessionKey = dispatch.payload.sessionKey;
    expect(sessionKey).toBeTruthy();

    const aliasSet = await requestHttp<{ alias: string; sessionKey: string }>(httpPort, '/alias', {
      method: 'POST',
      body: {
        action: 'set',
        alias: 'team',
        sessionKey,
      },
    });
    expect(aliasSet.statusCode).toBe(200);
    expect(aliasSet.payload.alias).toBe('team');
    expect(aliasSet.payload.sessionKey).toBe(sessionKey);

    const aliases = await requestHttp<{ aliases: Array<{ alias: string; sessionKey: string }> }>(httpPort, '/aliases');
    expect(aliases.statusCode).toBe(200);
    expect(aliases.payload.aliases.some((item) => item.alias === 'team' && item.sessionKey === sessionKey)).toBe(true);

    const aliasRemove = await requestHttp<{ removed: boolean; alias: string }>(httpPort, '/alias', {
      method: 'POST',
      body: {
        action: 'remove',
        alias: 'team',
      },
    });
    expect(aliasRemove.statusCode).toBe(200);
    expect(aliasRemove.payload.alias).toBe('team');
    expect(aliasRemove.payload.removed).toBe(true);

    const aliasesAfter = await requestHttp<{ aliases: Array<{ alias: string; sessionKey: string }> }>(httpPort, '/aliases');
    expect(aliasesAfter.statusCode).toBe(200);
    expect(aliasesAfter.payload.aliases.some((item) => item.alias === 'team')).toBe(false);

    const status = await requestHttp<{
      status: string;
      process: { pid: number; node: string };
      config: {
        dataDir: string;
        transport: {
          slack: boolean;
          discord: boolean;
          controlSocket: string;
        };
        engineMode: string;
      };
      sessions: unknown[];
      aliases: Array<{ alias: string; sessionKey: string }>;
    }>(httpPort, '/status');
    expect(status.statusCode).toBe(200);
    expect(status.payload.status).toBe('ok');
    expect(status.payload.process.pid).toBeGreaterThan(0);
    expect(status.payload.process.node).toBe(process.version);
    expect(status.payload.config.dataDir).toBe(workingDirectory);
    expect(status.payload.config.engineMode).toBe('mock');
    expect(Array.isArray(status.payload.sessions)).toBe(true);
    expect(Array.isArray(status.payload.aliases)).toBe(true);
  });
});

describe('socket control runtime', () => {
  let workingDirectory = '';
  let controlPlane: ControlPlane;
  let socketServer: { close: () => void };

  beforeEach(async () => {
    workingDirectory = await createWorkingDirectory();
    const socketPath = path.join(workingDirectory, 'control.sock');
    controlPlane = new ControlPlane(buildTestConfig(workingDirectory, socketPath), () => createEngine());
    await controlPlane.initialize();
    socketServer = createSocketServer(controlPlane, buildTestConfig(workingDirectory, socketPath), undefined as any);
  });

  afterEach(async () => {
    socketServer.close();
    controlPlane.stop();
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it('executes rpc send + get_message and rejects unknown rpc type', async () => {
    const sessionKey = 'discord:engineering:main';
    const sendResult = await sendSocket(socketPathFrom(workingDirectory), {
      type: 'send',
      id: 'send-1',
      sessionKey,
      message: 'status update?',
    });
    expect(sendResult).toMatchObject({
      type: 'response',
      command: 'send',
      success: true,
      id: 'send-1',
      data: {
        delivered: true,
        mode: 'direct',
      },
    });

    let message = null as any;
    for (let i = 0; i < 10; i += 1) {
      const getResult = await sendSocket(socketPathFrom(workingDirectory), {
        type: 'get_message',
        id: `get-${i}`,
        sessionKey,
      });
      message = (getResult as { data?: { message?: unknown } }).data?.message ?? null;
      if (message) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(message).toMatchObject({
      role: 'assistant',
      content: expect.stringContaining('engine:'),
    });

    const badType = await sendSocket(socketPathFrom(workingDirectory), { type: 'ping', id: 'bad-1', sessionKey });
    expect(badType).toMatchObject({
      type: 'response',
      command: 'ping',
      success: false,
      error: 'Unsupported command: ping',
    });
  });
});

describe('HTTP control auth gating', () => {
  let workingDirectory = '';
  let controlPlane: ControlPlane;
  let httpServer: http.Server;
  let httpPort = 0;

  beforeEach(async () => {
    workingDirectory = await createWorkingDirectory();
    const socketPath = path.join(workingDirectory, 'control.sock');
    const secureConfig = buildTestConfig(workingDirectory, socketPath, 0);
    secureConfig.CONTROL_AUTH_TOKEN = 'super-secret-token';

    controlPlane = new ControlPlane(secureConfig, () => createEngine());
    await controlPlane.initialize();
    httpServer = await createHttpServer(controlPlane, secureConfig, 0, undefined as any);
    httpPort = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    controlPlane.stop();
    await rm(workingDirectory, { recursive: true, force: true });
  });

  it('protects sessions and alias management behind auth token when enabled', async () => {
    const denied = await requestHttp<{ error: string }>(httpPort, '/sessions');
    expect(denied.statusCode).toBe(401);
    expect(denied.payload.error).toBe('unauthorized');

    const allowed = await requestHttp<{ sessions: unknown[] }>(httpPort, '/sessions', {
      headers: {
        Authorization: 'Bearer super-secret-token',
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(Array.isArray(allowed.payload.sessions)).toBe(true);

    const aliasDenied = await requestHttp<{ error: string }>(httpPort, '/alias', {
      method: 'POST',
      body: {
        action: 'list',
      },
    });
    expect(aliasDenied.statusCode).toBe(401);
    expect(aliasDenied.payload.error).toBe('unauthorized');

    const aliasAllowed = await requestHttp<{ aliases: unknown[] }>(httpPort, '/alias', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer super-secret-token',
      },
      body: {
        action: 'list',
      },
    });
    expect(aliasAllowed.statusCode).toBe(200);
    expect(Array.isArray(aliasAllowed.payload.aliases)).toBe(true);

    const statusDenied = await requestHttp<{ error: string }>(httpPort, '/status');
    expect(statusDenied.statusCode).toBe(401);
    expect(statusDenied.payload.error).toBe('unauthorized');

    const statusAllowed = await requestHttp<{ status: string; aliases: unknown[]; sessions: unknown[] }>(
      httpPort,
      '/status',
      {
        headers: {
          Authorization: 'Bearer super-secret-token',
        },
      },
    );
    expect(statusAllowed.statusCode).toBe(200);
    expect(statusAllowed.payload.status).toBe('ok');
    expect(Array.isArray(statusAllowed.payload.sessions)).toBe(true);
    expect(Array.isArray(statusAllowed.payload.aliases)).toBe(true);
  });
});

const socketPathFrom = (workingDirectory: string) => path.join(workingDirectory, 'control.sock');
