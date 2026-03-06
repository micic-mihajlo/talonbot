import type { ControlPlane } from '../control/index.js';
import type { TaskOrchestrator } from '../orchestration/task-orchestrator.js';
import type { SentryAgent } from '../orchestration/sentry-agent.js';
import { AGENT_PROFILES, type AgentProfile, type AgentRole, type AgentRuntimeState } from '../orchestration/agent-profiles.js';
import { discoverAgentPackages, resolveAgentsDir } from './agent-registry.js';

export interface AgentRuntimeRecord {
  id: string;
  role: AgentRole;
  enabled: boolean;
  state: AgentRuntimeState;
  summary: string;
  profile: AgentProfile;
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
  sentry?: SentryAgent;
}

export const buildAgentRuntimeSnapshot = async (
  options: BuildAgentRuntimeSnapshotOptions,
): Promise<AgentRuntimeSnapshot> => {
  const discovery = discoverAgentPackages(resolveAgentsDir());
  const byRole = new Map(discovery.packages.map((entry) => [entry.manifest.role, entry] as const));
  const controlSessions = options.control.listSessions().length;
  const controlAliases = options.control.listAliases().length;
  const agents: AgentRuntimeRecord[] = [
    {
      id: AGENT_PROFILES.control.id,
      role: 'control',
      enabled: true,
      state: 'ready',
      summary: `Control plane ready with ${controlSessions} active session(s) and ${controlAliases} alias(es).`,
      profile: AGENT_PROFILES.control,
      package: {
        version: byRole.get('control')?.manifest.version,
        manifestPath: byRole.get('control')?.manifestPath,
        skillPath: byRole.get('control')?.skillPath,
        skillLoaded: Boolean(byRole.get('control')),
      },
      metrics: {
        sessions: controlSessions,
        aliases: controlAliases,
      },
    },
  ];

  if (options.tasks) {
    const workerSnapshot = await options.tasks.getWorkerRuntimeSnapshot();
    const activeTasks = workerSnapshot.activeTasks.length;
    const orphanedSessions = workerSnapshot.orphanedSessions.length;
    agents.push({
      id: AGENT_PROFILES.worker.id,
      role: 'worker',
      enabled: true,
      state: activeTasks > 0 ? 'running' : orphanedSessions > 0 ? 'degraded' : 'idle',
      summary:
        activeTasks > 0
          ? `Worker runtime ${workerSnapshot.runtime} is executing ${activeTasks} task(s).`
          : orphanedSessions > 0
          ? `Worker runtime ${workerSnapshot.runtime} has ${orphanedSessions} orphaned session(s).`
          : `Worker runtime ${workerSnapshot.runtime} is idle.`,
      profile: AGENT_PROFILES.worker,
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
    agents.push({
      id: AGENT_PROFILES.worker.id,
      role: 'worker',
      enabled: false,
      state: 'disabled',
      summary: 'Worker runtime is not configured.',
      profile: AGENT_PROFILES.worker,
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
    agents.push({
      id: AGENT_PROFILES.sentry.id,
      role: 'sentry',
      enabled: true,
      state: status.incidents > 0 ? 'degraded' : 'idle',
      summary:
        status.incidents > 0
          ? `Sentry is tracking ${status.incidents} escalation incident(s).`
          : 'Sentry is idle with no active incidents.',
      profile: AGENT_PROFILES.sentry,
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
    agents.push({
      id: AGENT_PROFILES.sentry.id,
      role: 'sentry',
      enabled: false,
      state: 'disabled',
      summary: 'Sentry is disabled.',
      profile: AGENT_PROFILES.sentry,
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
