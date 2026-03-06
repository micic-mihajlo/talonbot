import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentLifecycleManager } from '../src/runtime/agent-manager.js';
import { config as defaultConfig } from '../src/config.js';
import type { AppConfig } from '../src/config.js';

const buildConfig = (sandbox: string): AppConfig => ({
  ...defaultConfig,
  DATA_DIR: path.join(sandbox, 'data'),
  CONTROL_SOCKET_PATH: path.join(sandbox, 'control.sock'),
  ENGINE_MODE: 'mock',
});

describe('agent lifecycle manager', () => {
  let sandbox = '';

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-agent-manager-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('discovers packaged agents and applies watchdog lifecycle state', async () => {
    let running = false;
    let starts = 0;
    let stops = 0;
    const manager = new AgentLifecycleManager(buildConfig(sandbox), {
      watchdog: {
        start: async () => {
          running = true;
          starts += 1;
          return true;
        },
        stop: async () => {
          running = false;
          stops += 1;
          return true;
        },
        isRunning: () => running,
      },
    });

    await manager.initialize();
    const initial = manager.listManagedAgents();
    expect(initial.map((agent) => agent.id)).toEqual(['coordinator', 'watchdog', 'worker']);
    expect(initial.find((agent) => agent.id === 'coordinator')?.actions).toEqual([]);
    expect(initial.find((agent) => agent.id === 'watchdog')?.actions).toContain('start');

    const started = await manager.apply('watchdog', 'start');
    expect(started?.running).toBe(true);
    expect(starts).toBe(1);

    const disabled = await manager.apply('watchdog', 'disable');
    expect(disabled?.desired.enabled).toBe(false);
    expect(disabled?.desired.autostart).toBe(false);
    expect(stops).toBe(1);

    const reenabled = await manager.apply('watchdog', 'autostart_on');
    expect(reenabled?.desired.installed).toBe(true);
    expect(reenabled?.desired.enabled).toBe(true);
    expect(reenabled?.desired.autostart).toBe(true);

    running = false;
    const reconciled = await manager.reconcile();
    expect(reconciled.results.find((item) => item.id === 'watchdog')?.action).toBe('started');
    expect(starts).toBe(2);
  });
});
