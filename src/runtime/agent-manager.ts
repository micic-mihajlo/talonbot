import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { discoverAgentPackages, resolveAgentsDir, type AgentDiscoveryResult, type AgentManifest, type AgentPackage } from './agent-registry.js';

export type AgentManagedMode = 'core' | 'task' | 'service';
export type AgentAction = 'install' | 'uninstall' | 'enable' | 'disable' | 'autostart_on' | 'autostart_off' | 'start' | 'stop';

export interface AgentStateEntry {
  installed?: boolean;
  enabled?: boolean;
  autostart?: boolean;
}

export interface AgentStateFile {
  version: number;
  agents: Record<string, AgentStateEntry>;
}

export interface AgentEffectiveState {
  installed: boolean;
  enabled: boolean;
  autostart: boolean;
}

export interface AgentController {
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
  isRunning(): boolean;
}

export interface ManagedAgentRecord {
  id: string;
  manifest: AgentManifest;
  package: AgentPackage;
  managedMode: AgentManagedMode;
  actions: AgentAction[];
  desired: AgentEffectiveState;
  running: boolean;
}

const STATE_FILE_VERSION = 1;

const DEFAULTS_BY_MODE: Record<AgentManagedMode, AgentEffectiveState> = {
  core: { installed: true, enabled: true, autostart: true },
  task: { installed: true, enabled: true, autostart: false },
  service: { installed: true, enabled: true, autostart: true },
};

const ACTIONS_BY_MODE: Record<AgentManagedMode, AgentAction[]> = {
  core: [],
  task: [],
  service: ['install', 'uninstall', 'enable', 'disable', 'autostart_on', 'autostart_off', 'start', 'stop'],
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

const isStateEntry = (value: unknown): value is AgentStateEntry => isRecord(value);

const resolveMode = (agentId: string): AgentManagedMode => {
  if (agentId === 'watchdog') return 'service';
  if (agentId === 'worker') return 'task';
  return 'core';
};

const resolveDefaultState = (manifest: AgentManifest, mode: AgentManagedMode): AgentEffectiveState => {
  const base = DEFAULTS_BY_MODE[mode];
  return {
    installed: typeof manifest.installed_by_default === 'boolean' ? manifest.installed_by_default : base.installed,
    enabled: typeof manifest.enabled_by_default === 'boolean' ? manifest.enabled_by_default : base.enabled,
    autostart: typeof manifest.autostart === 'boolean' ? manifest.autostart : base.autostart,
  };
};

const mergeState = (manifest: AgentManifest, mode: AgentManagedMode, state?: AgentStateEntry): AgentEffectiveState => {
  const fallback = resolveDefaultState(manifest, mode);
  if (mode !== 'service') {
    return fallback;
  }
  return {
    installed: typeof state?.installed === 'boolean' ? state.installed : fallback.installed,
    enabled: typeof state?.enabled === 'boolean' ? state.enabled : fallback.enabled,
    autostart: typeof state?.autostart === 'boolean' ? state.autostart : fallback.autostart,
  };
};

export class AgentLifecycleManager {
  private readonly stateFile: string;
  private state: AgentStateFile = { version: STATE_FILE_VERSION, agents: {} };
  private discoveryCache: AgentDiscoveryResult = { packages: [], diagnostics: [] };

  constructor(
    private readonly config: AppConfig,
    private readonly controllers: Partial<Record<string, AgentController>>,
  ) {
    this.stateFile = path.join(config.DATA_DIR.replace('~', process.env.HOME || ''), 'agents', 'state.json');
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
    const raw = await fs.readFile(this.stateFile, 'utf8').catch(() => '');
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        this.state = this.normalizeState(parsed);
      } catch {
        this.state = { version: STATE_FILE_VERSION, agents: {} };
      }
    }
    this.discoveryCache = discoverAgentPackages(resolveAgentsDir());
    await this.persist();
  }

  diagnostics() {
    return this.discoveryCache.diagnostics;
  }

  listManagedAgents(): ManagedAgentRecord[] {
    return this.discoveryCache.packages.map((pkg) => {
      const managedMode = resolveMode(pkg.id);
      const desired = mergeState(pkg.manifest, managedMode, this.state.agents[pkg.id]);
      const controller = this.controllers[pkg.id];
      return {
        id: pkg.id,
        manifest: pkg.manifest,
        package: pkg,
        managedMode,
        actions: ACTIONS_BY_MODE[managedMode],
        desired,
        running: controller ? controller.isRunning() : managedMode === 'core',
      };
    });
  }

  getManagedAgent(agentId: string) {
    return this.listManagedAgents().find((agent) => agent.id === agentId) || null;
  }

  async reconcile() {
    const results: Array<{ id: string; action: 'started' | 'stopped' | 'noop'; reason: string }> = [];
    for (const agent of this.listManagedAgents()) {
      if (agent.managedMode !== 'service') {
        results.push({ id: agent.id, action: 'noop', reason: `managed_by_${agent.managedMode}` });
        continue;
      }

      const controller = this.controllers[agent.id];
      if (!controller) {
        results.push({ id: agent.id, action: 'noop', reason: 'controller_unavailable' });
        continue;
      }

      const shouldRun = agent.desired.installed && agent.desired.enabled && agent.desired.autostart;
      if (shouldRun && !controller.isRunning()) {
        const started = await controller.start();
        results.push({ id: agent.id, action: started ? 'started' : 'noop', reason: started ? 'autostart_enabled' : 'start_failed' });
        continue;
      }

      if (!shouldRun && controller.isRunning()) {
        const stopped = await controller.stop();
        results.push({ id: agent.id, action: stopped ? 'stopped' : 'noop', reason: stopped ? 'desired_state_not_running' : 'stop_failed' });
        continue;
      }

      results.push({ id: agent.id, action: 'noop', reason: shouldRun ? 'already_running' : 'already_stopped' });
    }
    return {
      at: new Date().toISOString(),
      results,
    };
  }

  async apply(agentId: string, action: AgentAction) {
    const agent = this.getManagedAgent(agentId);
    if (!agent) {
      throw new Error('agent_not_found');
    }
    if (!agent.actions.includes(action)) {
      throw new Error('agent_action_not_supported');
    }

    const entry = { ...(this.state.agents[agentId] || {}) };
    const controller = this.controllers[agentId];

    if (action === 'install') entry.installed = true;
    if (action === 'uninstall') {
      entry.installed = false;
      entry.enabled = false;
      entry.autostart = false;
      if (controller?.isRunning()) {
        await controller.stop();
      }
    }
    if (action === 'enable') entry.enabled = true;
    if (action === 'disable') {
      entry.enabled = false;
      entry.autostart = false;
      if (controller?.isRunning()) {
        await controller.stop();
      }
    }
    if (action === 'autostart_on') {
      entry.installed = true;
      entry.enabled = true;
      entry.autostart = true;
    }
    if (action === 'autostart_off') entry.autostart = false;
    if (action === 'start') {
      entry.installed = true;
      entry.enabled = true;
      if (!controller) throw new Error('agent_controller_unavailable');
      const started = await controller.start();
      if (!started) throw new Error('agent_start_failed');
    }
    if (action === 'stop') {
      if (!controller) throw new Error('agent_controller_unavailable');
      const stopped = await controller.stop();
      if (!stopped && controller.isRunning()) throw new Error('agent_stop_failed');
    }

    this.state.agents[agentId] = entry;
    await this.persist();
    return this.getManagedAgent(agentId);
  }

  private normalizeState(raw: unknown): AgentStateFile {
    if (!isRecord(raw)) {
      return { version: STATE_FILE_VERSION, agents: {} };
    }
    const agentsRaw = isRecord(raw.agents) ? raw.agents : {};
    const agents: Record<string, AgentStateEntry> = {};
    for (const [id, value] of Object.entries(agentsRaw)) {
      if (!isStateEntry(value)) continue;
      agents[id] = {
        installed: typeof value.installed === 'boolean' ? value.installed : undefined,
        enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
        autostart: typeof value.autostart === 'boolean' ? value.autostart : undefined,
      };
    }
    return {
      version: STATE_FILE_VERSION,
      agents,
    };
  }

  private async persist() {
    await fs.writeFile(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
  }
}
