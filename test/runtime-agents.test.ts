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

const buildConfig = (sandbox: string, token: string): AppConfig => ({
  ...defaultConfig,
  DATA_DIR: path.join(sandbox, 'data'),
  CONTROL_SOCKET_PATH: path.join(sandbox, 'control.sock'),
  CONTROL_HTTP_PORT: 0,
  CONTROL_AUTH_TOKEN: token,
  ENGINE_MODE: 'mock',
});

const requestHttp = <T>(
  port: number,
  route: string,
  init: {
    method?: 'GET' | 'POST';
    token?: string;
  } = {},
): Promise<{ statusCode: number; payload: T }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: init.method ?? 'GET',
        hostname: '127.0.0.1',
        port,
        path: route,
        headers: init.token ? { Authorization: `Bearer ${init.token}` } : {},
      },
      async (res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of res) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }
        resolve({
          statusCode: res.statusCode || 0,
          payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T,
        });
      },
    );
    req.on('error', reject);
    req.end();
  });

describe('runtime agent lifecycle endpoints', () => {
  let sandbox = '';
  let controlPlane: ControlPlane;
  let httpServer: http.Server;
  let httpPort = 0;
  const token = 'runtime-agents-auth-token-123456';

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-runtime-agents-'));
    const config = buildConfig(sandbox, token);
    controlPlane = new ControlPlane(config, () => createEngine());
    await controlPlane.initialize();
    httpServer = await createHttpServer(controlPlane, config, 0, undefined as any, {
      tasks: {
        getWorkQueueSnapshot: () => ({
          total: 4,
          open: 3,
          claimed: 1,
          unclaimed: 2,
          blocked: 1,
          urgent: 1,
          high: 1,
        }),
        getWorkerRuntimeSnapshot: async () => ({
          runtime: 'mock',
          activeTasks: [],
          activeSessions: [],
          tmuxSessions: [],
          orphanedSessions: [],
        }),
      } as any,
      sentry: {
        isRunning: () => false,
        getStatus: () => ({
          scans: 0,
          trackedTasks: 0,
          incidents: 0,
          lastIncidentAt: null,
        }),
        listIncidents: () => [],
      } as any,
      agentManager: {
        listManagedAgents: () => [
          {
            id: 'coordinator',
            managedMode: 'core',
            actions: [],
            desired: { installed: true, enabled: true, autostart: true },
            running: true,
          },
          {
            id: 'watchdog',
            managedMode: 'service',
            actions: ['start', 'stop', 'enable', 'disable', 'install', 'uninstall', 'autostart_on', 'autostart_off'],
            desired: { installed: true, enabled: true, autostart: false },
            running: false,
          },
          {
            id: 'worker',
            managedMode: 'task',
            actions: [],
            desired: { installed: true, enabled: true, autostart: false },
            running: false,
          },
        ],
        apply: async (id: string) => ({
          id,
          managedMode: 'service',
          actions: ['start', 'stop'],
          desired: { installed: true, enabled: true, autostart: false },
          running: true,
        }),
        reconcile: async () => ({
          at: '2026-03-06T00:00:00.000Z',
          results: [{ id: 'watchdog', action: 'started', reason: 'autostart_enabled' }],
        }),
      } as any,
    });
    httpPort = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    await controlPlane.stop();
    await rm(sandbox, { recursive: true, force: true });
  });

  it('serves agent lifecycle routes behind auth', async () => {
    const denied = await requestHttp<{ error: string }>(httpPort, '/agents/watchdog/start', { method: 'POST' });
    expect(denied.statusCode).toBe(401);

    const list = await requestHttp<{ agents: Array<{ id: string; actions: string[]; summary: string; metrics: Record<string, number> }> }>(
      httpPort,
      '/agents',
      { token },
    );
    expect(list.statusCode).toBe(200);
    expect(list.payload.agents.find((agent) => agent.id === 'watchdog')?.actions).toContain('start');
    expect(list.payload.agents.find((agent) => agent.id === 'coordinator')).toMatchObject({
      summary: 'Coordinator ready with 3 open work item(s), 2 unclaimed, and 0 active session(s).',
      metrics: {
        queueOpen: 3,
        queueClaimed: 1,
        queueUnclaimed: 2,
        queueUrgent: 1,
      },
    });

    const started = await requestHttp<{ agent: { id: string; running: boolean } }>(httpPort, '/agents/watchdog/start', {
      method: 'POST',
      token,
    });
    expect(started.statusCode).toBe(200);
    expect(started.payload.agent).toMatchObject({ id: 'watchdog', running: true });

    const reconciled = await requestHttp<{ reconciled: { results: Array<{ id: string; action: string }> } }>(
      httpPort,
      '/agents/reconcile',
      {
        method: 'POST',
        token,
      },
    );
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.payload.reconciled.results[0]).toMatchObject({ id: 'watchdog', action: 'started' });
  });
});
