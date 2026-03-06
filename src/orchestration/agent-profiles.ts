import type { RequiredArtifactKind, TaskIntent } from './types.js';
import type { AgentPackage } from '../runtime/agent-registry.js';

export type AgentRole = 'control' | 'worker' | 'sentry';
export type AgentRuntimeState = 'ready' | 'idle' | 'running' | 'degraded' | 'disabled';

export interface AgentProfile {
  id: string;
  role: AgentRole;
  name: string;
  objective: string;
  operatingMode: string;
  responsibilities: string[];
  capabilities: string[];
}

export interface WorkerPromptInput {
  taskTitle: string;
  taskText: string;
  repoPath: string;
  worktreePath: string;
  memoryContext: string;
  taskIntent: TaskIntent;
  requiredArtifacts: RequiredArtifactKind[];
  requiresVerifiedPr: boolean;
  targetRepoFullName?: string;
}

const FALLBACK_SKILLS: Record<AgentRole, string> = {
  control: [
    '# Coordinator',
    '',
    'You coordinate inbound work, preserve source context, and keep operators informed.',
    'Delegate execution rather than doing task-scoped repo work yourself.',
  ].join('\n'),
  worker: [
    '# Worker',
    '',
    'You are a task-scoped engineering worker operating inside an isolated worktree.',
    'Complete the assigned task and return structured, verifiable evidence.',
  ].join('\n'),
  sentry: [
    '# Watchdog',
    '',
    'You monitor blocked and failed tasks that require escalation.',
    'Persist incidents and summarize what operators need to review.',
  ].join('\n'),
};

export const CONTROL_AGENT_PROFILE: AgentProfile = {
  id: 'coordinator',
  role: 'control',
  name: 'Coordinator',
  objective: 'Route incoming work, preserve thread context, and keep execution policy visible to operators.',
  operatingMode: 'Always-on session router and task coordinator.',
  responsibilities: [
    'Accept inbound work from chat, webhooks, and operator APIs.',
    'Dispatch tasks into the orchestrator with stable titles and source context.',
    'Surface execution status, policy state, and artifacts back to operators.',
  ],
  capabilities: ['session-routing', 'task-dispatch', 'thread-updates', 'operator-api'],
};

export const WORKER_AGENT_PROFILE: AgentProfile = {
  id: 'worker',
  role: 'worker',
  name: 'Worker',
  objective: 'Execute one scoped engineering task inside an isolated worktree and return verifiable evidence.',
  operatingMode: 'Task-scoped execution with structured JSON output.',
  responsibilities: [
    'Operate only within the assigned worktree.',
    'Prefer concrete artifacts over narrative-only completion.',
    'Report blocked states with the exact missing evidence or next action.',
  ],
  capabilities: ['isolated-worktree', 'structured-output', 'git-artifacts', 'policy-aware-execution'],
};

export const SENTRY_AGENT_PROFILE: AgentProfile = {
  id: 'watchdog',
  role: 'sentry',
  name: 'Watchdog',
  objective: 'Watch orchestration outcomes and persist escalation incidents for operator follow-up.',
  operatingMode: 'Background incident scanner with durable state.',
  responsibilities: [
    'Scan blocked and failed tasks that require escalation.',
    'Persist new incidents for later inspection.',
    'Emit escalation callbacks without interrupting the runtime.',
  ],
  capabilities: ['incident-tracking', 'background-scans', 'escalation-callbacks'],
};

export const AGENT_PROFILES: Record<AgentRole, AgentProfile> = {
  control: CONTROL_AGENT_PROFILE,
  worker: WORKER_AGENT_PROFILE,
  sentry: SENTRY_AGENT_PROFILE,
};

export const agentSkillBody = (role: AgentRole, agentPackage?: AgentPackage | null) =>
  agentPackage?.skillBody?.trim() || FALLBACK_SKILLS[role];

export const buildWorkerPrompt = (input: WorkerPromptInput, agentPackage?: AgentPackage | null) => {
  const requiredArtifacts = input.requiredArtifacts.length > 0 ? input.requiredArtifacts.join(', ') : 'summary';
  const policyLines = [
    `Task intent: ${input.taskIntent}`,
    `Required artifacts: ${requiredArtifacts}`,
    `Verified PR required: ${input.requiresVerifiedPr ? 'yes' : 'no'}`,
    `Target repo override: ${input.targetRepoFullName || 'none'}`,
  ];

  return [
    agentSkillBody('worker', agentPackage),
    '',
    '## Runtime Task Context',
    `Task title: ${input.taskTitle}`,
    `Task: ${input.taskText}`,
    `Repo path: ${input.repoPath}`,
    `Worktree path: ${input.worktreePath}`,
    '',
    'Execution policy:',
    ...policyLines.map((line) => `- ${line}`),
    '',
    'Rules:',
    '- Make changes only inside the assigned worktree.',
    '- Prefer concrete outputs: changed files, commits, PR URLs, and checks evidence when available.',
    '- If you are blocked, set state="blocked" and explain the exact missing dependency or operator action.',
    '- If a PR already exists or is created during the task, include prUrl when you know it.',
    '',
    'Return JSON only:',
    '{"summary":"short summary","state":"done|blocked","commitMessage":"optional","prTitle":"optional","prBody":"optional","testOutput":"optional","prUrl":"optional","branch":"optional"}',
    '',
    'Team memory context:',
    input.memoryContext || '(none)',
  ].join('\n');
};
