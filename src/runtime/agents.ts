import type { ControlPlane } from '../control/index.js';
import type { TaskOrchestrator } from '../orchestration/task-orchestrator.js';
import { AGENT_PROFILES, type AgentProfile, type AgentRole, type AgentRuntimeState } from '../orchestration/agent-profiles.js';
import { discoverAgentPackages, resolveAgentsDir } from './agent-registry.js';
import type { WatchdogService } from './watchdog-service.js';
import type { AgentLifecycleManager, AgentAction, AgentManagedMode } from './agent-manager.js';

export interface AgentRuntimeRecord {
  id: string;
  role: AgentRole;
  enabled: boolean;
  state: AgentRuntimeState;
  summary: string;
  profile: AgentProfile;
  managedMode: AgentManagedMode;
  actions: AgentAction[];
  desired: {
    installed: boolean;
    enabled: boolean;
    autostart: boolean;
  };
  running: boolean;
  package: {
    version?: string;
    manifestPath?: string;
    skillPath?: string;
    skillLoaded: boolean;
  };
  metrics: Record<string, boolean | number | string | null>;
}

export interface AgentRuntimeSnapshot {
  generatedAt: string;
  agents: AgentRuntimeRecord[];
  diagnostics: string[];
}

interface BuildAgentRuntimeSnapshotOptions {
  control: ControlPlane;
  tasks?: TaskOrchestrator;
  sentry?: WatchdogService;
  agentManager?: AgentLifecycleManager;
}

export const buildAgentRuntimeSnapshot = async (
  options: BuildAgentRuntimeSnapshotOptions,
): Promise<AgentRuntimeSnapshot> => {
  const discovery = discoverAgentPackages(resolveAgentsDir());
  const managed = options.agentManager?.listManagedAgents() || [];
  const byRole = new Map(discovery.packages.map((entry) => [entry.manifest.role, entry] as const));
  const byId = new Map(managed.map((entry) => [entry.id, entry] as const));
  const controlSessions = options.control.listSessions().length;
  const controlAliases = options.control.listAliases().length;
  const queue = options.tasks?.getWorkQueueSnapshot?.();
  const agents: AgentRuntimeRecord[] = [
    {
      id: AGENT_PROFILES.control.id,
      role: 'control',
      enabled: byId.get(AGENT_PROFILES.control.id)?.desired.enabled ?? true,
      state: 'ready',
      summary:
        queue && queue.open > 0
          ? `Coordinator ready with ${queue.open} open work item(s), ${queue.unclaimed} unclaimed, and ${controlSessions} active session(s).`
          : `Coordinator ready with ${controlSessions} active session(s) and ${controlAliases} alias(es).`,
      profile: AGENT_PROFILES.control,
      managedMode: byId.get(AGENT_PROFILES.control.id)?.managedMode ?? 'core',
      actions: byId.get(AGENT_PROFILES.control.id)?.actions ?? [],
      desired: byId.get(AGENT_PROFILES.control.id)?.desired ?? { installed: true, enabled: true, autostart: true },
      running: byId.get(AGENT_PROFILES.control.id)?.running ?? true,
      package: {
        version: byRole.get('control')?.manifest.version,
        manifestPath: byRole.get('control')?.manifestPath,
        skillPath: byRole.get('control')?.skillPath,
        skillLoaded: Boolean(byRole.get('control')),
      },
      metrics: {
        sessions: controlSessions,
        aliases: controlAliases,
        queueOpen: queue?.open ?? 0,
        queueClaimed: queue?.claimed ?? 0,
        queueUnclaimed: queue?.unclaimed ?? 0,
        queueUrgent: queue?.urgent ?? 0,
      },
    },
  ];

  if (options.tasks) {
    const workerSnapshot = await options.tasks.getWorkerRuntimeSnapshot();
    const activeTasks = workerSnapshot.activeTasks.length;
    const orphanedSessions = workerSnapshot.orphanedSessions.length;
    const workerManaged = byId.get(AGENT_PROFILES.worker.id);
    agents.push({
      id: AGENT_PROFILES.worker.id,
      role: 'worker',
      enabled: workerManaged?.desired.enabled ?? true,
      state: activeTasks > 0 ? 'running' : orphanedSessions > 0 ? 'degraded' : 'idle',
      summary:
        activeTasks > 0
          ? `Worker runtime ${workerSnapshot.runtime} is executing ${activeTasks} task(s).`
          : orphanedSessions > 0
          ? `Worker runtime ${workerSnapshot.runtime} has ${orphanedSessions} orphaned session(s).`
          : `Worker runtime ${workerSnapshot.runtime} is idle.`,
      profile: AGENT_PROFILES.worker,
      managedMode: workerManaged?.managedMode ?? 'task',
      actions: workerManaged?.actions ?? [],
      desired: workerManaged?.desired ?? { installed: true, enabled: true, autostart: false },
      running: workerManaged?.running ?? activeTasks > 0,
      package: {
        version: byRole.get('worker')?.manifest.version,
        manifestPath: byRole.get('worker')?.manifestPath,
        skillPath: byRole.get('worker')?.skillPath,
        skillLoaded: Boolean(byRole.get('worker')),
      },
      metrics: {
        runtime: workerSnapshot.runtime,
        activeTasks,
        activeSessions: workerSnapshot.activeSessions.length,
        tmuxSessions: workerSnapshot.tmuxSessions.length,
        orphanedSessions,
      },
    });
  } else {
    const workerManaged = byId.get(AGENT_PROFILES.worker.id);
    agents.push({
      id: AGENT_PROFILES.worker.id,
      role: 'worker',
      enabled: workerManaged?.desired.enabled ?? false,
      state: 'disabled',
      summary: 'Worker runtime is not configured.',
      profile: AGENT_PROFILES.worker,
      managedMode: workerManaged?.managedMode ?? 'task',
      actions: workerManaged?.actions ?? [],
      desired: workerManaged?.desired ?? { installed: true, enabled: true, autostart: false },
      running: workerManaged?.running ?? false,
      package: {
        version: byRole.get('worker')?.manifest.version,
        manifestPath: byRole.get('worker')?.manifestPath,
        skillPath: byRole.get('worker')?.skillPath,
        skillLoaded: Boolean(byRole.get('worker')),
      },
      metrics: {
        runtime: null,
        activeTasks: 0,
        activeSessions: 0,
        tmuxSessions: 0,
        orphanedSessions: 0,
      },
    });
  }

  if (options.sentry) {
    const status = options.sentry.getStatus();
    const sentryManaged = byId.get(AGENT_PROFILES.sentry.id);
    agents.push({
      id: AGENT_PROFILES.sentry.id,
      role: 'sentry',
      enabled: sentryManaged?.desired.enabled ?? true,
      state: !options.sentry.isRunning() ? 'disabled' : status.incidents > 0 ? 'degraded' : 'idle',
      summary:
        !options.sentry.isRunning()
          ? 'Watchdog is configured but not running.'
          : status.incidents > 0
          ? `Watchdog is tracking ${status.incidents} escalation incident(s).`
          : 'Watchdog is idle with no active incidents.',
      profile: AGENT_PROFILES.sentry,
      managedMode: sentryManaged?.managedMode ?? 'service',
      actions: sentryManaged?.actions ?? [],
      desired: sentryManaged?.desired ?? { installed: true, enabled: true, autostart: true },
      running: sentryManaged?.running ?? options.sentry.isRunning(),
      package: {
        version: byRole.get('sentry')?.manifest.version,
        manifestPath: byRole.get('sentry')?.manifestPath,
        skillPath: byRole.get('sentry')?.skillPath,
        skillLoaded: Boolean(byRole.get('sentry')),
      },
      metrics: {
        scans: status.scans,
        trackedTasks: status.trackedTasks,
        incidents: status.incidents,
        lastIncidentAt: status.lastIncidentAt,
      },
    });
  } else {
    const sentryManaged = byId.get(AGENT_PROFILES.sentry.id);
    agents.push({
      id: AGENT_PROFILES.sentry.id,
      role: 'sentry',
      enabled: sentryManaged?.desired.enabled ?? false,
      state: 'disabled',
      summary: 'Watchdog is disabled.',
      profile: AGENT_PROFILES.sentry,
      managedMode: sentryManaged?.managedMode ?? 'service',
      actions: sentryManaged?.actions ?? [],
      desired: sentryManaged?.desired ?? { installed: true, enabled: true, autostart: true },
      running: sentryManaged?.running ?? false,
      package: {
        version: byRole.get('sentry')?.manifest.version,
        manifestPath: byRole.get('sentry')?.manifestPath,
        skillPath: byRole.get('sentry')?.skillPath,
        skillLoaded: Boolean(byRole.get('sentry')),
      },
      metrics: {
        scans: 0,
        trackedTasks: 0,
        incidents: 0,
        lastIncidentAt: null,
      },
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    agents,
    diagnostics: discovery.diagnostics,
  };
};
