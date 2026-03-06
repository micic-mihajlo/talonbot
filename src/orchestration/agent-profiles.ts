import type { RequiredArtifactKind, TaskIntent } from './types.js';

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

export const CONTROL_AGENT_PROFILE: AgentProfile = {
  id: 'control-agent',
  role: 'control',
  name: 'Control Agent',
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
  id: 'worker-agent',
  role: 'worker',
  name: 'Worker Agent',
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
  id: 'sentry-agent',
  role: 'sentry',
  name: 'Sentry Agent',
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

export const buildWorkerPrompt = (input: WorkerPromptInput) => {
  const requiredArtifacts = input.requiredArtifacts.length > 0 ? input.requiredArtifacts.join(', ') : 'summary';
  const policyLines = [
    `Task intent: ${input.taskIntent}`,
    `Required artifacts: ${requiredArtifacts}`,
    `Verified PR required: ${input.requiresVerifiedPr ? 'yes' : 'no'}`,
    `Target repo override: ${input.targetRepoFullName || 'none'}`,
  ];

  return [
    `You are ${WORKER_AGENT_PROFILE.name.toLowerCase()} for Talonbot.`,
    WORKER_AGENT_PROFILE.objective,
    `Operating mode: ${WORKER_AGENT_PROFILE.operatingMode}`,
    '',
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
