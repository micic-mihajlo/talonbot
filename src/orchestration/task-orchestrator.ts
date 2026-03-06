import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildEngine } from '../engine/index.js';
import type { AgentEngine } from '../engine/types.js';
import type { AppConfig } from '../config.js';
import type {
  RepoRegistration,
  RepoRegistrationInput,
  RequiredArtifactKind,
  SubmitTaskInput,
  TaskArtifact,
  WorkItemCoordination,
  WorkItemNote,
  WorkItemPriority,
  TaskLifecycleEvent,
  TaskLifecycleEventType,
  TaskProgressReport,
  TaskIntent,
  TaskRecord,
  TaskSourceContext,
  TaskSnapshot,
  TaskStatus,
  WorkItemRecord,
} from './types.js';
import { RepoRegistry } from './repo-registry.js';
import { WorktreeManager } from './worktree-manager.js';
import { GitHubAutomation } from './github-automation.js';
import { buildWorkerPrompt as buildWorkerAgentPrompt } from './agent-profiles.js';
import { TeamMemory } from '../memory/team-memory.js';
import { WorkerLauncher } from './worker-launcher.js';
import { OrchestrationHealthMonitor, type OrchestrationHealthSnapshot } from './health-monitor.js';
import { extractGitHubPullRequestUrls, verifyGitHubPullRequestUrl } from '../utils/github-pr.js';
import { createLogger } from '../utils/logger.js';
import { getAgentPackage, type AgentPackage } from '../runtime/agent-registry.js';

const randomId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const buildTaskTitle = (text: string, fallback = 'Untitled task') => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return fallback;
  }
  if (normalized.length <= 72) {
    return normalized;
  }
  return `${normalized.slice(0, 69).trimEnd()}...`;
};

const normalizeSourceContext = (input?: TaskSourceContext): TaskSourceContext | undefined => {
  if (!input) {
    return undefined;
  }
  const transport =
    input.transport === 'slack' || input.transport === 'discord' || input.transport === 'socket' ? input.transport : null;
  const channelId = typeof input.channelId === 'string' ? input.channelId.trim() : '';
  if (!transport || !channelId) {
    return undefined;
  }
  const threadId = typeof input.threadId === 'string' ? (input.threadId.trim() || undefined) : input.threadId === null ? null : undefined;
  const messageId = typeof input.messageId === 'string' && input.messageId.trim() ? input.messageId.trim() : undefined;
  const senderId = typeof input.senderId === 'string' && input.senderId.trim() ? input.senderId.trim() : undefined;
  const senderName = typeof input.senderName === 'string' && input.senderName.trim() ? input.senderName.trim() : undefined;
  const receivedAt = typeof input.receivedAt === 'string' && input.receivedAt.trim() ? input.receivedAt.trim() : undefined;
  return {
    transport,
    channelId,
    threadId,
    messageId,
    senderId,
    senderName,
    receivedAt,
  };
};

const normalizeArtifactKinds = (artifacts?: ReadonlyArray<string> | undefined): RequiredArtifactKind[] | undefined => {
  if (!artifacts?.length) {
    return undefined;
  }

  const next = new Set<RequiredArtifactKind>();
  for (const artifact of artifacts) {
    if (artifact === 'summary' || artifact === 'branch' || artifact === 'commit' || artifact === 'pr') {
      next.add(artifact);
    }
  }

  return next.size > 0 ? Array.from(next) : undefined;
};

const uniqueArtifacts = (artifacts: ReadonlyArray<RequiredArtifactKind>) => [...new Set(artifacts)];
const WORK_ITEM_PRIORITIES: WorkItemPriority[] = ['low', 'normal', 'high', 'urgent'];
const isWorkItemPriority = (value: unknown): value is WorkItemPriority =>
  value === 'low' || value === 'normal' || value === 'high' || value === 'urgent';

const TASK_INTENT_TOKEN_SETS: ReadonlyArray<{
  intent: TaskIntent;
  tokens: ReadonlyArray<string>;
}> = [
  {
    intent: 'implementation',
    tokens: [
      'implement',
      'implementation',
      'fix',
      'patch',
      'create',
      'add',
      'modify',
      'change',
      'build',
      'develop',
      'refactor',
      'remove',
      'delete',
      'setup',
      'deploy',
      'release',
    ],
  },
  { intent: 'review', tokens: ['review', 'inspect', 'audit', 'evaluate', 'analyze', 'checks', 'validate'] },
  { intent: 'research', tokens: ['research', 'investigate', 'study', 'explore', 'compare', 'check'] },
  { intent: 'summarize', tokens: ['summarize', 'summary', 'brief', 'recap', 'tl;dr'] },
  {
    intent: 'ops',
    tokens: [
      'ops',
      'restart',
      'reboot',
      'service',
      'deploy',
      'incident',
      'rollback',
      'scale',
      'alert',
      'observability',
      'health',
    ],
  },
];

const inferTaskIntent = (text: string): TaskIntent => {
  const tokens = text.toLowerCase().match(/[a-z0-9_-]+/g) || [];
  const tokenSet = new Set(tokens);
  for (const rule of TASK_INTENT_TOKEN_SETS) {
    if (rule.tokens.some((token) => tokenSet.has(token))) {
      return rule.intent;
    }
  }
  return 'unknown';
};

const isTaskIntent = (value: unknown): value is TaskIntent =>
  value === 'research' || value === 'review' || value === 'summarize' || value === 'implementation' || value === 'ops' || value === 'unknown';

const TERMINAL_STATUSES = new Set<TaskStatus>(['done', 'failed', 'blocked', 'cancelled']);

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error;
const ALLOWED_TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  queued: new Set(['running', 'cancelled']),
  running: new Set(['queued', 'done', 'failed', 'blocked', 'cancelled']),
  blocked: new Set(['queued', 'failed', 'done']),
  done: new Set(['queued', 'blocked', 'failed']),
  failed: new Set(['queued', 'blocked', 'done']),
  cancelled: new Set(['queued']),
};

const TASK_EVENT_TYPE_BY_STATUS: Record<TaskStatus, TaskLifecycleEventType> = {
  queued: 'task_queued',
  running: 'task_running',
  blocked: 'task_blocked',
  done: 'task_done',
  failed: 'task_failed',
  cancelled: 'task_cancelled',
};

const isTaskStatus = (value: unknown): value is TaskStatus =>
  value === 'queued' || value === 'running' || value === 'blocked' || value === 'done' || value === 'failed' || value === 'cancelled';

const buildSyntheticEvent = (sessionKey: string, text: string) => ({
  id: randomId('task-event'),
  source: 'socket' as const,
  sourceChannelId: sessionKey,
  sourceMessageId: randomId('task-message'),
  senderId: 'coordinator',
  senderName: 'coordinator',
  senderIsBot: false,
  text,
  mentionsBot: true,
  attachments: [],
  metadata: {},
  receivedAt: new Date().toISOString(),
});

const toEventDetails = (details?: Record<string, unknown>) => {
  if (!details) return undefined;
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || value === null) continue;
    normalized[key] = Array.isArray(value) ? value.map((item) => String(item)).join(', ') : String(value);
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

const normalizeTimeoutMs = (value: unknown, fallback: number) => {
  const parsed = Number.isFinite(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(30 * 60 * 1000, Math.max(1000, Math.floor(parsed)));
};

const stringifyUnknownError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return '[unserializable_error_object]';
    }
  }
  return String(error);
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const splitShellArgs = (args: string) =>
  args && args.trim().length > 0
    ? args
        .trim()
        .match(/(?:"[^"]*"|[^\s"]+)/g)
        ?.map((value) => value.replace(/^"(.*)"$/, '$1')) ?? []
    : [];
const execFileAsync = promisify(execFile);
const MAX_INFRA_REPAIR_ATTEMPTS = 1;
const REPAIRABLE_INFRA_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /\bnot found\b/i,
  /\bcommand not found\b/i,
  /\bENOENT\b/i,
  /\bCannot find module\b/i,
  /\bnpm ERR!\b/i,
  /\byarn: not found\b/i,
  /\bpnpm: not found\b/i,
  /\bvitest: not found\b/i,
];

interface ParsedEngineOutput {
  summary: string;
  state?: 'done' | 'blocked';
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
  testOutput?: string;
  prUrl?: string;
  branch?: string;
}

interface TransitionInput {
  to: TaskStatus;
  kind: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface WorkerRuntimeTaskStatus {
  taskId: string;
  repoId: string;
  status: TaskStatus;
  session: string;
  worktreePath?: string;
  branch?: string;
  startedAt?: string;
}

export interface WorkerRuntimeSnapshot {
  runtime: 'inline' | 'tmux';
  sessionPrefix: string;
  activeTasks: WorkerRuntimeTaskStatus[];
  activeSessions: string[];
  tmuxSessions: string[];
  orphanedSessions: string[];
}

export interface WorkerCleanupReport {
  runtime: 'inline' | 'tmux';
  scanned: number;
  killed: string[];
  kept: string[];
  reason?: string;
}

export interface WorkerStopReport {
  session: string;
  taskId?: string;
  cancelRequested: boolean;
  tmuxStopped: boolean;
}

export class TaskOrchestrator {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly queue: string[] = [];
  private readonly running = new Set<string>();
  private stopping = false;
  private readonly taskFile: string;
  private readonly repoRegistry: RepoRegistry;
  private readonly worktree: WorktreeManager;
  private readonly github = new GitHubAutomation();
  private readonly memory: TeamMemory;
  private readonly engine: AgentEngine;
  private readonly launcher: WorkerLauncher;
  private readonly healthMonitor = new OrchestrationHealthMonitor();
  private readonly lifecycleListeners = new Map<string, (event: TaskLifecycleEvent) => void>();
  private readonly workerAgentPackage: AgentPackage | null;
  private maintenanceInFlight = false;
  private lastMaintenanceAt = 0;
  private healthCache?: { atMs: number; snapshot: OrchestrationHealthSnapshot };

  constructor(private readonly config: AppConfig) {
    const dataDir = config.DATA_DIR.replace('~', process.env.HOME || '');
    this.taskFile = path.join(dataDir, 'tasks', 'state.json');
    this.repoRegistry = new RepoRegistry(path.join(dataDir, 'repos', 'registry.json'));
    this.worktree = new WorktreeManager(config.WORKTREE_ROOT_DIR);
    this.launcher = new WorkerLauncher(this.worktree, {
      sessionPrefix: config.WORKER_SESSION_PREFIX,
      tmuxBinary: config.TMUX_BINARY,
    });
    this.memory = new TeamMemory(path.join(dataDir, 'memory'), config, createLogger('memory', config.LOG_LEVEL as any));
    this.engine = buildEngine(config, 'orchestrator');
    this.workerAgentPackage = getAgentPackage('worker').package;
  }

  async initialize() {
    await this.repoRegistry.initialize();
    await this.worktree.initialize();
    await this.memory.initialize();
    await this.memory.prune();
    await this.load();
    await this.runMaintenance(true);
    this.pump();
  }

  listTasks() {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listWorkItems() {
    return this.listTasks()
      .map((task) => this.toWorkItem(task))
      .sort((a, b) => {
        const priorityDelta = WORK_ITEM_PRIORITIES.indexOf(b.coordination.priority) - WORK_ITEM_PRIORITIES.indexOf(a.coordination.priority);
        if (priorityDelta !== 0) return priorityDelta;
        if (a.coordination.claimStatus !== b.coordination.claimStatus) {
          return a.coordination.claimStatus === 'unclaimed' ? -1 : 1;
        }
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }

  getWorkItem(workItemId: string) {
    const task = this.getTask(workItemId);
    if (!task) return null;
    return this.toWorkItem(task);
  }

  getTask(taskId: string) {
    return this.tasks.get(taskId) || null;
  }

  buildTaskReport(taskId: string): TaskProgressReport | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return this.buildProgressReport(task);
  }

  listTaskReports(taskIds?: string[]) {
    const tasks = taskIds?.length
      ? taskIds.map((taskId) => this.tasks.get(taskId)).filter((task): task is TaskRecord => Boolean(task))
      : this.listTasks();
    return tasks.map((task) => this.buildProgressReport(task));
  }

  getMemoryStatus() {
    return this.memory.status();
  }

  getWorkQueueSnapshot() {
    const items = this.listWorkItems();
    const open = items.filter((item) => item.status !== 'done' && item.status !== 'failed' && item.status !== 'cancelled');
    return {
      total: items.length,
      open: open.length,
      claimed: open.filter((item) => item.coordination.claimStatus === 'claimed').length,
      unclaimed: open.filter((item) => item.coordination.claimStatus === 'unclaimed').length,
      blocked: open.filter((item) => item.status === 'blocked').length,
      urgent: open.filter((item) => item.coordination.priority === 'urgent').length,
      high: open.filter((item) => item.coordination.priority === 'high').length,
    };
  }

  async claimWorkItem(workItemId: string, owner: string) {
    const task = this.tasks.get(workItemId);
    if (!task) {
      throw new Error('work_item_not_found');
    }
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      throw new Error('work_item_owner_required');
    }
    const now = new Date().toISOString();
    task.coordination = {
      ...this.normalizeCoordination(task.coordination, task),
      owner: normalizedOwner,
      claimedAt: now,
      lastCoordinatorActionAt: now,
    };
    task.updatedAt = now;
    task.events.push({
      at: now,
      kind: 'work_item_claimed',
      message: `Work item claimed by ${normalizedOwner}.`,
    });
    await this.persist();
    return this.toWorkItem(task);
  }

  async releaseWorkItem(workItemId: string) {
    const task = this.tasks.get(workItemId);
    if (!task) {
      throw new Error('work_item_not_found');
    }
    const now = new Date().toISOString();
    const coordination = this.normalizeCoordination(task.coordination, task);
    task.coordination = {
      ...coordination,
      owner: undefined,
      claimedAt: undefined,
      lastCoordinatorActionAt: now,
    };
    task.updatedAt = now;
    task.events.push({
      at: now,
      kind: 'work_item_released',
      message: 'Work item released back to the coordinator queue.',
    });
    await this.persist();
    return this.toWorkItem(task);
  }

  async addWorkItemNote(workItemId: string, author: string, text: string) {
    const task = this.tasks.get(workItemId);
    if (!task) {
      throw new Error('work_item_not_found');
    }
    const normalizedAuthor = author.trim();
    const normalizedText = text.trim();
    if (!normalizedAuthor) {
      throw new Error('work_item_note_author_required');
    }
    if (!normalizedText) {
      throw new Error('work_item_note_text_required');
    }
    const now = new Date().toISOString();
    const coordination = this.normalizeCoordination(task.coordination, task);
    const note: WorkItemNote = {
      at: now,
      author: normalizedAuthor,
      text: normalizedText,
    };
    task.coordination = {
      ...coordination,
      notes: [...coordination.notes, note].slice(-20),
      lastCoordinatorActionAt: now,
    };
    task.updatedAt = now;
    task.events.push({
      at: now,
      kind: 'work_item_note',
      message: `${normalizedAuthor} added a coordinator note.`,
    });
    await this.persist();
    return this.toWorkItem(task);
  }

  async setWorkItemPriority(workItemId: string, priority: WorkItemPriority) {
    const task = this.tasks.get(workItemId);
    if (!task) {
      throw new Error('work_item_not_found');
    }
    if (!isWorkItemPriority(priority)) {
      throw new Error('invalid_work_item_priority');
    }
    const now = new Date().toISOString();
    const coordination = this.normalizeCoordination(task.coordination, task);
    task.coordination = {
      ...coordination,
      priority,
      lastCoordinatorActionAt: now,
    };
    task.updatedAt = now;
    task.events.push({
      at: now,
      kind: 'work_item_priority',
      message: `Work item priority set to ${priority}.`,
    });
    await this.persist();
    return this.toWorkItem(task);
  }

  onLifecycle(listener: (event: TaskLifecycleEvent) => void) {
    const id = randomId('task-listener');
    this.lifecycleListeners.set(id, listener);
    return () => {
      this.lifecycleListeners.delete(id);
    };
  }

  async getHealthStatus(force = false): Promise<OrchestrationHealthSnapshot> {
    const nowMs = Date.now();
    if (!force && this.healthCache && nowMs - this.healthCache.atMs < 5000) {
      return this.healthCache.snapshot;
    }

    const worktrees = await this.worktree.listWorktrees();
    const snapshot = this.healthMonitor.scan({
      tasks: this.listTasks(),
      runningTaskIds: Array.from(this.running.values()),
      worktrees: worktrees.map((entry) => ({ path: entry.path, mtimeMs: entry.mtimeMs })),
      staleRunningMs: this.config.TASK_STUCK_MINUTES * 60 * 1000,
      staleQueuedMs: this.config.TASK_QUEUE_STALE_MINUTES * 60 * 1000,
      staleWorktreeMs: this.config.WORKTREE_STALE_HOURS * 60 * 60 * 1000,
    });

    this.healthCache = {
      atMs: nowMs,
      snapshot,
    };

    return snapshot;
  }

  async getWorkerRuntimeSnapshot(): Promise<WorkerRuntimeSnapshot> {
    const activeTasks = Array.from(this.tasks.values())
      .filter((task) => task.status === 'running' && task.assignedSession)
      .map((task) => ({
        taskId: task.id,
        repoId: task.repoId,
        status: task.status,
        session: task.assignedSession,
        worktreePath: task.worktreePath,
        branch: task.branch,
        startedAt: task.startedAt,
      }));
    const activeSessions = Array.from(new Set(activeTasks.map((task) => task.session)));

    if (this.config.WORKER_RUNTIME !== 'tmux') {
      return {
        runtime: 'inline',
        sessionPrefix: this.config.WORKER_SESSION_PREFIX,
        activeTasks,
        activeSessions,
        tmuxSessions: [],
        orphanedSessions: [],
      };
    }

    const sessionPrefix = `${this.config.WORKER_SESSION_PREFIX}-`;
    const tmuxSessions = await this.launcher
      .listTmuxSessions()
      .then((sessions) => sessions.filter((session) => session.startsWith(sessionPrefix)));
    const activeSessionSet = new Set(activeSessions);
    const orphanedSessions = tmuxSessions.filter((session) => !activeSessionSet.has(session));

    return {
      runtime: 'tmux',
      sessionPrefix: this.config.WORKER_SESSION_PREFIX,
      activeTasks,
      activeSessions,
      tmuxSessions,
      orphanedSessions,
    };
  }

  async cleanupOrphanedWorkers(): Promise<WorkerCleanupReport> {
    if (this.config.WORKER_RUNTIME !== 'tmux') {
      return {
        runtime: 'inline',
        scanned: 0,
        killed: [],
        kept: [],
        reason: 'WORKER_RUNTIME is inline',
      };
    }

    const snapshot = await this.getWorkerRuntimeSnapshot();
    const activeSet = new Set(snapshot.activeSessions);
    const killed: string[] = [];
    const kept: string[] = [];

    for (const session of snapshot.tmuxSessions) {
      if (activeSet.has(session)) {
        kept.push(session);
        continue;
      }
      await this.launcher.killTmuxSession(session).catch(() => undefined);
      killed.push(session);
    }

    await this.runMaintenance(true);
    return {
      runtime: 'tmux',
      scanned: snapshot.tmuxSessions.length,
      killed,
      kept,
    };
  }

  async stopWorkerSession(sessionKey: string): Promise<WorkerStopReport> {
    const target = sessionKey.trim();
    if (!target) {
      throw new Error('worker_session_required');
    }

    const isTmuxRuntime = this.config.WORKER_RUNTIME === 'tmux';
    if (isTmuxRuntime) {
      const sessionPrefix = `${this.config.WORKER_SESSION_PREFIX}-`;
      if (!target.startsWith(sessionPrefix)) {
        throw new Error('worker_session_out_of_scope');
      }
    }

    const runningTask = Array.from(this.tasks.values()).find((task) => task.status === 'running' && task.assignedSession === target);
    let cancelRequested = false;
    if (runningTask) {
      cancelRequested = await this.cancelTask(runningTask.id);
    }

    let tmuxStopped = false;
    if (isTmuxRuntime) {
      const sessions = await this.launcher.listTmuxSessions().catch((): string[] => []);
      if (sessions.includes(target)) {
        await this.launcher.killTmuxSession(target).catch(() => undefined);
        tmuxStopped = true;
      }
    }

    return {
      session: target,
      taskId: runningTask?.id,
      cancelRequested,
      tmuxStopped,
    };
  }

  async submitTask(input: SubmitTaskInput) {
    const source = input.source || 'operator';

    if (input.fanout?.length) {
      return this.submitFanout(input);
    }

    const repo = this.resolveRepo(input.repoId);
    const task = this.createTask({
      source,
      text: input.text,
      title: input.title,
      repoId: repo.id,
      targetRepoFullName: input.targetRepoFullName,
      engineTimeoutMs: input.engineTimeoutMs,
      sessionKey: input.sessionKey,
      parentTaskId: input.parentTaskId,
      taskIntent: input.taskIntent,
      requirePrOverride: input.requirePrOverride,
      requiresVerifiedPr: input.requiresVerifiedPr,
      requiredArtifacts: input.requiredArtifacts,
      sourceContext: input.sourceContext,
      coordination: input.coordination,
    });

    this.tasks.set(task.id, task);
    this.queue.push(task.id);
    this.emitLifecycle(task, 'Task queued.');
    await this.persist();
    this.pump();
    return task;
  }

  async retryTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error('task_not_found');
    }

    if (task.status === 'running') {
      throw new Error('task_running');
    }

    task.error = undefined;
    task.escalationRequired = false;
    task.cancelRequested = false;
    task.finishedAt = undefined;
    this.transitionTask(task, {
      to: 'queued',
      kind: 'retry_requested',
      message: 'Task manually re-queued by operator.',
    });

    this.queue.push(task.id);
    await this.persist();
    this.pump();
    return task;
  }

  async cancelTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'queued') {
      this.transitionTask(task, {
        to: 'cancelled',
        kind: 'cancelled',
        message: 'Task cancelled before launch.',
      });
      this.removeFromQueue(taskId);
      await this.persist();
      return true;
    }

    if (task.status === 'running') {
      task.cancelRequested = true;
      task.updatedAt = new Date().toISOString();
      task.events.push({
        at: task.updatedAt,
        kind: 'cancel_requested',
        message: 'Cancellation requested while task is running.',
      });
      await this.persist();
      return true;
    }

    return false;
  }

  listRepos() {
    return this.repoRegistry.list();
  }

  async registerRepo(input: RepoRegistrationInput) {
    return this.repoRegistry.register(input);
  }

  async removeRepo(repoId: string) {
    return this.repoRegistry.remove(repoId);
  }

  private async submitFanout(input: SubmitTaskInput) {
    const fanout = input.fanout || [];
    const repo = this.resolveRepo(input.repoId);

    const parent = this.createTask({
      source: input.source || 'operator',
      text: input.text,
      title: input.title,
      repoId: repo.id,
      targetRepoFullName: input.targetRepoFullName,
      engineTimeoutMs: input.engineTimeoutMs,
      sessionKey: input.sessionKey,
      parentTaskId: input.parentTaskId,
      taskIntent: input.taskIntent,
      requirePrOverride: input.requirePrOverride,
      requiresVerifiedPr: input.requiresVerifiedPr,
      requiredArtifacts: input.requiredArtifacts,
      sourceContext: input.sourceContext,
      coordination: input.coordination,
      status: 'blocked',
    });

    this.tasks.set(parent.id, parent);
    this.emitLifecycle(parent, 'Fan-out parent task created.');

    for (const childPrompt of fanout) {
      const child = this.createTask({
        source: input.source || 'operator',
        text: childPrompt,
        title: buildTaskTitle(childPrompt),
        repoId: repo.id,
        targetRepoFullName: input.targetRepoFullName,
        engineTimeoutMs: input.engineTimeoutMs,
        sessionKey: input.sessionKey,
        parentTaskId: parent.id,
        taskIntent: input.taskIntent,
        requirePrOverride: input.requirePrOverride,
        requiresVerifiedPr: input.requiresVerifiedPr,
        requiredArtifacts: input.requiredArtifacts,
        sourceContext: input.sourceContext,
        coordination: input.coordination,
      });
      parent.children.push(child.id);
      this.tasks.set(child.id, child);
      this.queue.push(child.id);
      this.emitLifecycle(child, 'Fan-out child task queued.');
    }

    await this.persist();
    this.pump();
    return parent;
  }

  private createTask(input: {
    source: TaskRecord['source'];
    text: string;
    title?: string;
    repoId: string;
    targetRepoFullName?: string;
    engineTimeoutMs?: number;
    sessionKey?: string;
    parentTaskId?: string;
    status?: TaskStatus;
    taskIntent?: TaskIntent;
    requiresVerifiedPr?: boolean;
    requirePrOverride?: boolean;
    requiredArtifacts?: SubmitTaskInput['requiredArtifacts'];
    sourceContext?: TaskSourceContext;
    coordination?: Partial<WorkItemCoordination>;
  }): TaskRecord {
    const now = new Date().toISOString();
    const id = randomId('task');
    const status = input.status || 'queued';
    const assignedSession = this.launcher.assignedSession(input.repoId, id, input.text);
    const title = buildTaskTitle(input.title || input.text);
    const inferredTaskIntent = inferTaskIntent(input.text);
    const configuredIntent = isTaskIntent(input.taskIntent) ? input.taskIntent : inferredTaskIntent;
    const requiresVerifiedPr =
      typeof input.requirePrOverride === 'boolean'
        ? input.requirePrOverride
        : typeof input.requiresVerifiedPr === 'boolean'
          ? input.requiresVerifiedPr
          : configuredIntent === 'implementation'
            ? this.config.CHAT_REQUIRE_VERIFIED_PR
            : false;
    const requiredArtifacts = normalizeArtifactKinds(input.requiredArtifacts) || (requiresVerifiedPr ? ['pr'] : ['summary']);
    const hasTaskTimeoutOverride = Number.isFinite(input.engineTimeoutMs);
    const engineTimeoutMs = hasTaskTimeoutOverride
      ? normalizeTimeoutMs(input.engineTimeoutMs, this.config.ENGINE_TIMEOUT_MS)
      : undefined;

    return {
      id,
      parentTaskId: input.parentTaskId,
      sessionKey: input.sessionKey,
      title,
      taskIntent: configuredIntent,
      requiresVerifiedPr,
      requiredArtifacts: uniqueArtifacts(
        requiresVerifiedPr && requiredArtifacts && !requiredArtifacts.includes('pr') ? [...requiredArtifacts, 'pr'] : requiredArtifacts || ['summary'],
      ),
      source: input.source,
      text: input.text,
      repoId: input.repoId,
      sourceContext: normalizeSourceContext(input.sourceContext),
      coordination: this.normalizeCoordination(input.coordination, {
        text: input.text,
        title,
        sourceContext: normalizeSourceContext(input.sourceContext),
      }),
      targetRepoFullName: typeof input.targetRepoFullName === 'string' && input.targetRepoFullName.trim()
        ? input.targetRepoFullName.trim()
        : undefined,
      engineTimeoutMs,
      status,
      state: status,
      assignedSession,
      workerSessionKey: assignedSession,
      retryCount: 0,
      maxRetries: this.config.WORKER_MAX_RETRIES,
      escalationRequired: false,
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      children: [],
      events: [
        {
          at: now,
          kind: 'created',
          message: 'Task created.',
        },
      ],
    };
  }

  private resolveRepo(repoId?: string): RepoRegistration {
    const selected = repoId ? this.repoRegistry.get(repoId) : this.repoRegistry.getDefault();
    if (!selected) {
      throw new Error('repo_not_found');
    }
    return selected;
  }

  private pump() {
    if (this.stopping) {
      return;
    }

    void this.runMaintenance();

    while (this.running.size < this.config.TASK_MAX_CONCURRENCY && this.queue.length > 0) {
      const taskId = this.queue.shift();
      if (!taskId) break;

      const task = this.tasks.get(taskId);
      if (!task || task.status !== 'queued') {
        continue;
      }

      this.running.add(taskId);
      void this.runTask(taskId).finally(() => {
        this.running.delete(taskId);
        if (!this.stopping) {
          this.pump();
        }
      });
    }
  }

  private getTaskCompletionPolicy(task: TaskRecord) {
    const taskIntent = isTaskIntent(task.taskIntent) ? task.taskIntent : inferTaskIntent(task.text);
    const requiresVerifiedPr =
      typeof task.requiresVerifiedPr === 'boolean'
        ? task.requiresVerifiedPr
        : taskIntent === 'implementation'
          ? this.config.CHAT_REQUIRE_VERIFIED_PR
          : false;
    const requiredArtifacts = uniqueArtifacts(normalizeArtifactKinds(task.requiredArtifacts) || (requiresVerifiedPr ? ['pr'] : ['summary']));
    const effectiveRequiredArtifacts = requiresVerifiedPr && !requiredArtifacts.includes('pr') ? uniqueArtifacts([...requiredArtifacts, 'pr']) : requiredArtifacts;

    return {
      taskIntent,
      requiresVerifiedPr,
      requiredArtifacts: effectiveRequiredArtifacts,
    };
  }

  private getMissingRequiredArtifacts(task: TaskRecord, requiredArtifacts: RequiredArtifactKind[]) {
    const missing: RequiredArtifactKind[] = [];
    for (const artifact of requiredArtifacts) {
      const present = this.hasArtifactForCompletionTask(task, artifact);
      if (!present) {
        missing.push(artifact);
      }
    }
    return missing;
  }

  private normalizeCoordination(
    raw: Partial<WorkItemCoordination> | undefined,
    fallback: {
      text: string;
      title?: string;
      sourceContext?: TaskSourceContext;
    },
  ): WorkItemCoordination {
    const title = typeof fallback.title === 'string' && fallback.title.trim() ? fallback.title.trim() : buildTaskTitle(fallback.text);
    const sourceBits = [
      fallback.sourceContext?.senderName || fallback.sourceContext?.senderId || 'unknown sender',
      fallback.sourceContext?.transport ? `via ${fallback.sourceContext.transport}` : '',
      fallback.sourceContext?.channelId ? `in ${fallback.sourceContext.channelId}` : '',
    ].filter(Boolean);
    const defaultSummary = sourceBits.length > 0 ? `${title} from ${sourceBits.join(' ')}` : title;
    return {
      priority: isWorkItemPriority(raw?.priority) ? raw.priority : 'normal',
      owner: typeof raw?.owner === 'string' && raw.owner.trim() ? raw.owner.trim() : undefined,
      claimedAt: typeof raw?.claimedAt === 'string' ? raw.claimedAt : undefined,
      sourceSummary: typeof raw?.sourceSummary === 'string' && raw.sourceSummary.trim() ? raw.sourceSummary.trim() : defaultSummary,
      notes: Array.isArray(raw?.notes)
        ? raw.notes
            .filter((note): note is WorkItemNote => Boolean(note && typeof note === 'object'))
            .map((note) => ({
              at: typeof note.at === 'string' ? note.at : new Date().toISOString(),
              author: typeof note.author === 'string' ? note.author : 'coordinator',
              text: typeof note.text === 'string' ? note.text : '',
            }))
            .filter((note) => note.text.trim().length > 0)
            .slice(-20)
        : [],
      lastCoordinatorActionAt: typeof raw?.lastCoordinatorActionAt === 'string' ? raw.lastCoordinatorActionAt : undefined,
    };
  }

  private hasArtifactForCompletionTask(task: TaskRecord, artifact: RequiredArtifactKind) {
    if (artifact === 'summary') {
      return Boolean(task.artifacts.some((item) => item.kind === 'summary'));
    }
    if (artifact === 'commit') {
      return Boolean(this.latestArtifact(task, 'git_commit'));
    }
    if (artifact === 'pr') {
      const prUrl = this.latestArtifact(task, 'pull_request')?.prUrl;
      return Boolean(prUrl);
    }
    if (artifact === 'branch') {
      return Boolean(task.branch || this.latestArtifact(task, 'launcher')?.branch);
    }
    return false;
  }

  private async enrichPullRequestContext(task: TaskRecord, worktreePath: string, prUrl: string) {
    const context = await this.github.getPullRequestContext(worktreePath, prUrl).catch(() => null);
    if (!context) {
      return null;
    }

    const at = new Date().toISOString();
    const currentChecksSummary = this.latestArtifact(task, 'checks')?.checksSummary;
    if (context.checks.summary && context.checks.summary !== currentChecksSummary) {
      this.appendArtifact(
        task,
        {
          kind: 'checks',
          at,
          checksSummary: context.checks.summary,
          checksPassed: context.checks.passed,
          summary: context.checks.summary,
        },
        false,
      );
    }

    if (context.previewUrls.length > 0) {
      this.appendArtifact(
        task,
        {
          kind: 'preview',
          at,
          prUrl,
          previewUrls: context.previewUrls,
          summary: `Detected ${context.previewUrls.length} preview URL(s).`,
        },
        true,
      );
    }

    if (context.review.totalComments > 0 || context.review.totalReviews > 0) {
      this.appendArtifact(
        task,
        {
          kind: 'review_feedback',
          at,
          prUrl,
          reviewSummary: context.review.summary,
          reviewDecision: context.review.decision,
          reviewComments: context.review.totalComments,
          changeRequests: context.review.changeRequests,
          summary: context.review.summary,
        },
        true,
      );
    }

    return context;
  }

  private reviewFeedbackRequiresAction(
    review: { decision: string; totalComments: number; totalReviews: number; changeRequests: number } | null | undefined,
  ) {
    if (!review) {
      return false;
    }
    if (review.changeRequests > 0) {
      return true;
    }
    return review.decision === 'changes_requested';
  }

  private async runTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    let repo: RepoRegistration | null = null;
    let launchedPath = '';
    let launchedBranch = '';

    try {
      this.transitionTask(task, {
        to: 'running',
        kind: 'started',
        message: 'Worker launch started.',
      });
      await this.persist();

      repo = this.resolveRepo(task.repoId);
      const launched = await this.launcher.launch(repo, task.id, task.text);
      launchedPath = launched.path;
      launchedBranch = launched.branch;
      task.assignedSession = launched.assignedSession;
      task.workerSessionKey = launched.assignedSession;
      task.worktreePath = launched.path;
      task.branch = launched.branch;

      this.appendArtifact(
        task,
        {
          kind: 'launcher',
          at: new Date().toISOString(),
          summary: 'Worker launched.',
          worktreePath: launched.path,
          branch: launched.branch,
          details: {
            assignedSession: launched.assignedSession,
            baseRef: launched.baseRef,
          },
        },
        false,
      );
      task.events.push({
        at: new Date().toISOString(),
        kind: 'worker_launched',
        message: `Worker launched in ${launched.path}.`,
        details: toEventDetails({
          assignedSession: launched.assignedSession,
          branch: launched.branch,
          worktreePath: launched.path,
        }),
      });
      await this.persist();

      const preflight = await this.runWorkerPreflight(task, launched.path, false);
      if (preflight.details.length > 0) {
        task.events.push({
          at: new Date().toISOString(),
          kind: 'worker_preflight',
          message: preflight.repaired ? 'Worker preflight repaired worktree dependencies.' : 'Worker preflight checks passed.',
          details: toEventDetails({
            repaired: preflight.repaired,
            details: preflight.details,
          }),
        });
        await this.persist();
      }

      const memoryContext = await this.memory.readBootContext({
        taskId: task.id,
        taskText: task.text,
        repoId: repo.id,
        taskIntent: task.taskIntent,
        sessionKey: task.sessionKey,
        limitBytes: this.config.MEMORY_PROVIDER === 'qmd' ? this.config.QMD_MAX_CONTEXT_BYTES : undefined,
      });
      const outputText = await this.runWorkerTurn(task, repo, launched.path, memoryContext);

      if (task.cancelRequested) {
        this.transitionTask(task, {
          to: 'cancelled',
          kind: 'cancelled',
          message: 'Task cancelled after current step completed.',
        });
        await this.persist();
        this.updateParentState(task);
        return;
      }

      const parsed = this.parseEngineOutput(outputText);
      this.appendArtifact(task, {
        kind: 'summary',
        at: new Date().toISOString(),
        summary: parsed.summary,
        worktreePath: launched.path,
        branch: launched.branch,
      });

      if (parsed.testOutput?.trim()) {
        this.appendArtifact(
          task,
          {
            kind: 'test_output',
            at: new Date().toISOString(),
            testOutput: parsed.testOutput.trim().slice(0, 2000),
            summary: 'Worker supplied test output.',
          },
          false,
        );
      }

      if (parsed.branch?.trim()) {
        task.branch = parsed.branch.trim();
      }

      const currentPrUrl = this.latestArtifact(task, 'pull_request')?.prUrl;
      if (parsed.prUrl && parsed.prUrl !== currentPrUrl) {
        this.appendArtifact(
          task,
          {
            kind: 'pull_request',
            at: new Date().toISOString(),
            prUrl: parsed.prUrl,
            branch: task.branch,
            summary: 'Worker supplied pull request URL.',
          },
          false,
        );
      }

      const changedFiles = await this.github.listChangedFiles(launched.path).catch(() => []);
      if (changedFiles.length > 0) {
        this.appendArtifact(
          task,
          {
            kind: 'file_changes',
            at: new Date().toISOString(),
            filesChanged: changedFiles,
            summary: `Detected ${changedFiles.length} changed file(s).`,
          },
          false,
        );
      }

      const policy = this.getTaskCompletionPolicy(task);
      let prContext:
        | {
            checks: { summary: string; passed: boolean };
            previewUrls: string[];
            review: { summary: string; decision: string; totalComments: number; totalReviews: number; changeRequests: number };
          }
        | null = null;
      const summaryOnlyPolicy = !policy.requiresVerifiedPr && policy.requiredArtifacts.every((artifact) => artifact === 'summary');

      if (parsed.state === 'blocked') {
        if (summaryOnlyPolicy && parsed.summary.trim()) {
          task.events.push({
            at: new Date().toISOString(),
            kind: 'summary_fallback',
            message: 'Worker returned blocked state but summary-only policy allows completion fallback.',
            details: toEventDetails({
              intent: policy.taskIntent,
              requiredArtifacts: policy.requiredArtifacts,
            }),
          });
        } else {
          task.error = parsed.summary;
          this.transitionTask(task, {
            to: 'blocked',
            kind: 'blocked',
            message: parsed.summary,
          });
          await this.persist();
          this.updateParentState(task);
          return;
        }
      }

      if (this.config.TASK_AUTO_COMMIT) {
        const commitSha = await this.github.commitAll(launched.path, parsed.commitMessage || `task(${task.id}): automated update`);
        if (commitSha) {
          this.appendArtifact(
            task,
            {
              kind: 'git_commit',
              at: new Date().toISOString(),
              commitSha,
              summary: `Committed changes as ${commitSha}.`,
            },
            false,
          );
        }

        if (commitSha && this.config.TASK_AUTO_PR) {
          await this.github.pushBranch(launched.path, repo.remote, launched.branch);
          const prUrl = await this.github.openPullRequest(launched.path, {
            title: parsed.prTitle || `Task ${task.id}: ${task.text.slice(0, 80)}`,
            body: parsed.prBody || `Automated task execution for ${task.id}.`,
            base: repo.defaultBranch,
            head: launched.branch,
          });

          this.appendArtifact(
            task,
            {
              kind: 'pull_request',
              at: new Date().toISOString(),
              prUrl,
              summary: 'Opened pull request.',
            },
            false,
          );

          const checks = await this.github
            .waitForPullRequestChecks(launched.path, prUrl, {
              timeoutMs: this.config.PR_CHECK_TIMEOUT_MS,
              pollMs: this.config.PR_CHECK_POLL_MS,
            })
            .catch(() => ({
              summary: 'checks unavailable',
              passed: false,
              pending: false,
              total: 0,
              failed: ['unavailable'],
            }));

          this.appendArtifact(
            task,
            {
              kind: 'checks',
              at: new Date().toISOString(),
              checksSummary: checks.summary,
              checksPassed: checks.passed,
              summary: checks.summary,
            },
            false,
          );

          if (!checks.passed) {
            task.escalationRequired = true;
            task.error = `PR checks did not pass: ${checks.summary}`;
            this.transitionTask(task, {
              to: 'blocked',
              kind: 'blocked',
              message: task.error,
              details: {
                prUrl,
              },
            });
            await this.persist();
            this.updateParentState(task);
            return;
          }

          prContext = await this.enrichPullRequestContext(task, launched.path, prUrl);
        }
      }

      if (policy.requiresVerifiedPr) {
        let prUrl = this.latestArtifact(task, 'pull_request')?.prUrl;
        if (!prUrl && repo && launched.path) {
          prUrl = await this.tryCreateMissingPullRequest(task, repo, launched.path);
        }
        const expectedHeadRefName = task.targetRepoFullName ? undefined : task.branch || this.latestArtifact(task, 'launcher')?.branch;
        if (!prUrl && repo && launched.path && !task.targetRepoFullName) {
          const discovered = await this.github
            .findPullRequestByBranch(launched.path, {
              expectedHeadRefName,
              taskId: task.id,
            })
            .catch(() => null);
          if (discovered?.url) {
            this.appendArtifact(
              task,
              {
                kind: 'pull_request',
                at: new Date().toISOString(),
                prUrl: discovered.url,
                branch: discovered.headRefName,
                summary: 'Discovered pull request from repository branch metadata.',
              },
              false,
            );
            prUrl = discovered.url;
          }
        }
        const verified = prUrl
          ? await verifyGitHubPullRequestUrl(prUrl, 10000, expectedHeadRefName, task.targetRepoFullName)
          : false;
        if (!verified) {
          task.error = 'blocked: verified_pr_required';
          this.appendArtifact(
            task,
            {
              kind: 'error',
              at: new Date().toISOString(),
              summary: 'Task blocked pending verified PR URL.',
              prUrl,
            },
            false,
          );
          this.transitionTask(task, {
            to: 'blocked',
            kind: 'blocked',
            message: 'Blocked pending verified PR URL.',
            details: {
              reason: 'verified_pr_required',
              prUrl: prUrl || '',
              requiredArtifacts: policy.requiredArtifacts.join(','),
            },
          });
          await this.persist();
          this.updateParentState(task);
          return;
        }
      }

      const finalPrUrl = this.latestArtifact(task, 'pull_request')?.prUrl;
      if (finalPrUrl && !prContext) {
        prContext = await this.enrichPullRequestContext(task, launched.path, finalPrUrl);
      }

      if (finalPrUrl && this.reviewFeedbackRequiresAction(prContext?.review)) {
        task.escalationRequired = true;
        task.error = `blocked: review_feedback_required - ${prContext?.review.summary || 'review feedback requires action'}`;
        this.transitionTask(task, {
          to: 'blocked',
          kind: 'review_feedback_required',
          message: 'Blocked pending pull request review feedback.',
          details: {
            prUrl: finalPrUrl,
            reviewDecision: prContext?.review.decision || 'unknown',
            reviewSummary: prContext?.review.summary || '',
          },
        });
        await this.persist();
        this.updateParentState(task);
        return;
      }

      const missingRequiredArtifacts = this.getMissingRequiredArtifacts(task, policy.requiredArtifacts);
      if (missingRequiredArtifacts.length > 0) {
        const prUrl = this.latestArtifact(task, 'pull_request')?.prUrl;
        const missing = missingRequiredArtifacts.join(', ');
        task.error = `blocked: required_artifacts_missing - ${missing}`;
        this.transitionTask(task, {
          to: 'blocked',
          kind: 'blocked',
          message: `Blocked pending required artifacts: ${missing}.`,
          details: {
            reason: 'required_artifacts_missing',
            requiredArtifacts: policy.requiredArtifacts.join(','),
            missingArtifacts: missingRequiredArtifacts,
            prUrl: prUrl || '',
          },
        });
        this.appendArtifact(
          task,
          {
            kind: 'error',
            at: new Date().toISOString(),
            summary: `Task blocked pending required artifacts: ${missing}.`,
            prUrl,
          },
          false,
        );
        await this.persist();
        this.updateParentState(task);
        return;
      }

      this.ensureNoArtifactState(task, 'done');
      this.transitionTask(task, {
        to: 'done',
        kind: 'completed',
        message: parsed.summary,
        details: {
          prUrl: this.latestArtifact(task, 'pull_request')?.prUrl,
        },
      });

      await this.memory.recordTaskCompletion({
        taskId: task.id,
        repoId: repo.id,
        state: task.status,
        summary: parsed.summary,
      });

      await this.persist();
      this.updateParentState(task);
    } catch (error) {
      const errorMessage = stringifyUnknownError(error);
      const repairAttempts = this.countInfraRepairAttempts(task);
      if (
        repo &&
        launchedPath &&
        repairAttempts < MAX_INFRA_REPAIR_ATTEMPTS &&
        this.isRepairableInfraError(errorMessage) &&
        !task.cancelRequested
      ) {
        task.events.push({
          at: new Date().toISOString(),
          kind: 'infra_repair_attempt',
          message: `Detected repairable infrastructure failure. Attempting self-heal (${repairAttempts + 1}/${MAX_INFRA_REPAIR_ATTEMPTS}).`,
          details: toEventDetails({
            error: errorMessage,
          }),
        });
        try {
          const repair = await this.runWorkerPreflight(task, launchedPath, true);
          if (repair.repaired) {
            this.transitionTask(task, {
              to: 'queued',
              kind: 'infra_repair_retry',
              message: `Recovered infrastructure issue and scheduled retry: ${errorMessage}`,
              details: toEventDetails({
                details: repair.details,
              }),
            });
            this.queue.push(task.id);
            await this.persist();
            this.updateParentState(task);
            return;
          }
        } catch (repairError) {
          task.events.push({
            at: new Date().toISOString(),
            kind: 'infra_repair_failed',
            message: `Infrastructure self-heal failed: ${stringifyUnknownError(repairError)}`,
          });
        }
      }

      task.retryCount += 1;
      task.updatedAt = new Date().toISOString();
      task.error = errorMessage;
      this.appendArtifact(
        task,
        {
          kind: 'error',
          at: task.updatedAt,
          summary: task.error,
        },
        false,
      );

      if (task.retryCount <= task.maxRetries) {
        this.transitionTask(task, {
          to: 'queued',
          kind: 'retry_scheduled',
          message: `Worker failed: ${task.error}. Retry ${task.retryCount}/${task.maxRetries}.`,
        });
        this.queue.push(task.id);
      } else {
        task.escalationRequired = true;
        this.transitionTask(task, {
          to: 'failed',
          kind: 'failed',
          message: `Worker failed permanently after ${task.retryCount} attempts: ${task.error}.`,
        });
      }

      await this.persist();
      this.updateParentState(task);
    } finally {
      if (this.config.WORKER_RUNTIME === 'tmux' && task.assignedSession) {
        await this.launcher.killTmuxSession(task.assignedSession).catch(() => undefined);
      }

      if (repo && launchedPath) {
        const decision = this.launcher.shouldCleanup(task.status, {
          autoCleanup: this.config.TASK_AUTOCLEANUP,
          failedRetentionHours: this.config.FAILED_WORKTREE_RETENTION_HOURS,
        });

        if (decision.cleanup) {
          await this.worktree.cleanupWorktree(repo, launchedPath, launchedBranch).catch(() => undefined);
        } else {
          task.events.push({
            at: new Date().toISOString(),
            kind: 'cleanup_retained',
            message: `Retaining worktree (${decision.reason}).`,
            details: toEventDetails({ worktreePath: launchedPath, branch: launchedBranch }),
          });
          await this.persist();
        }
      }

      void this.runMaintenance();
    }
  }

  private updateParentState(task: TaskRecord) {
    if (!task.parentTaskId) return;
    const parent = this.tasks.get(task.parentTaskId);
    if (!parent) return;

    const children = parent.children
      .map((taskId) => this.tasks.get(taskId))
      .filter((item): item is TaskRecord => Boolean(item));

    if (children.some((child) => child.status === 'failed')) {
      parent.error = 'One or more fan-out tasks failed.';
      parent.escalationRequired = true;
      this.transitionTask(parent, {
        to: 'failed',
        kind: 'fanout_failed',
        message: parent.error,
      });
      void this.persist();
      return;
    }

    if (children.every((child) => child.status === 'done')) {
      this.appendArtifact(parent, {
        kind: 'summary',
        at: new Date().toISOString(),
        summary: `All ${children.length} child tasks completed.`,
      });
      this.ensureNoArtifactState(parent, 'done');
      this.transitionTask(parent, {
        to: 'done',
        kind: 'fanout_completed',
        message: `All ${children.length} child tasks completed.`,
      });
      void this.persist();
      return;
    }

    this.transitionTask(parent, {
      to: 'blocked',
      kind: 'fanout_waiting',
      message: 'Waiting for all fan-out tasks to finish.',
    });
    void this.persist();
  }

  private buildWorkerPrompt(task: TaskRecord, repoPath: string, worktreePath: string, memoryContext: string) {
    const policy = this.getTaskCompletionPolicy(task);
    return buildWorkerAgentPrompt({
      taskTitle: task.title,
      taskText: task.text,
      repoPath,
      worktreePath,
      memoryContext,
      taskIntent: policy.taskIntent,
      requiredArtifacts: policy.requiredArtifacts,
      requiresVerifiedPr: policy.requiresVerifiedPr,
      targetRepoFullName: task.targetRepoFullName,
    }, this.workerAgentPackage);
  }

  private async runWorkerTurn(task: TaskRecord, repo: RepoRegistration, worktreePath: string, memoryContext: string) {
    const prompt = this.buildWorkerPrompt(task, repo.path, worktreePath, memoryContext);
    if (this.config.WORKER_RUNTIME === 'tmux') {
      return this.runWorkerTurnViaTmux(task, repo, worktreePath, prompt);
    }

    const output = await this.engine.complete({
      sessionKey: task.assignedSession,
      route: `task:${task.id}`,
      text: prompt,
      senderId: 'coordinator',
      metadata: {
        taskId: task.id,
        repoId: repo.id,
        engineTimeoutMs: String(this.resolveTaskTimeoutMs(task)),
      },
      contextLines: [],
      rawEvent: buildSyntheticEvent(task.assignedSession, task.text),
      recentAttachments: [],
    });
    return output.text;
  }

  private async runWorkerTurnViaTmux(task: TaskRecord, repo: RepoRegistration, worktreePath: string, prompt: string) {
    const runtimeDir = path.join(worktreePath, '.talon-worker');
    await fs.mkdir(runtimeDir, { recursive: true });

    const payloadPath = path.join(runtimeDir, `${task.id}.payload.json`);
    const stdoutPath = path.join(runtimeDir, `${task.id}.stdout.log`);
    const stderrPath = path.join(runtimeDir, `${task.id}.stderr.log`);
    const exitPath = path.join(runtimeDir, `${task.id}.exit.code`);
    const scriptPath = path.join(runtimeDir, `${task.id}.run.sh`);

    const payload = JSON.stringify({
      kind: 'agent_turn',
      route: `task:${task.id}`,
      session: task.assignedSession,
      sender: 'coordinator',
      message: prompt,
      metadata: {
        taskId: task.id,
        repoId: repo.id,
      },
      context: [],
      attachments: [],
    });
    await fs.writeFile(payloadPath, payload, { encoding: 'utf8' });
    await fs.rm(stdoutPath, { force: true }).catch(() => undefined);
    await fs.rm(stderrPath, { force: true }).catch(() => undefined);
    await fs.rm(exitPath, { force: true }).catch(() => undefined);

    const cmdTokens = [this.config.ENGINE_COMMAND, ...splitShellArgs(this.config.ENGINE_ARGS)];
    const quotedCmdTokens = cmdTokens.map((token) => shellQuote(token)).join(' ');
    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `PAYLOAD=$(cat ${shellQuote(payloadPath)})`,
      `OUT=${shellQuote(stdoutPath)}`,
      `ERR=${shellQuote(stderrPath)}`,
      `EXIT=${shellQuote(exitPath)}`,
      `CMD=(${quotedCmdTokens})`,
      'set +e',
      '"${CMD[@]}" "$PAYLOAD" >"$OUT" 2>"$ERR"',
      'STATUS=$?',
      'set -e',
      'echo "$STATUS" > "$EXIT"',
    ].join('\n');
    await fs.writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });

    await this.launcher.startTmuxSession(task.assignedSession, worktreePath, `bash ${shellQuote(scriptPath)}`);
    task.events.push({
      at: new Date().toISOString(),
      kind: 'tmux_worker_started',
      message: `tmux worker session started (${task.assignedSession}).`,
      details: toEventDetails({
        session: task.assignedSession,
        worktreePath,
      }),
    });
    await this.persist();

    const deadline = Date.now() + this.resolveTaskTimeoutMs(task);
    while (Date.now() <= deadline) {
      const done = await fs
        .access(exitPath)
        .then(() => true)
        .catch(() => false);
      if (done) break;
      await new Promise((resolve) => setTimeout(resolve, this.config.WORKER_TMUX_POLL_MS));
    }

    const exitRaw = await fs.readFile(exitPath, { encoding: 'utf8' }).catch(() => '');
    if (!exitRaw.trim()) {
      await this.launcher.killTmuxSession(task.assignedSession).catch(() => undefined);
      throw new Error(`tmux worker timed out waiting for completion (session=${task.assignedSession})`);
    }

    const exitCode = Number.parseInt(exitRaw.trim(), 10);
    const stdout = await fs.readFile(stdoutPath, { encoding: 'utf8' }).catch(() => '');
    const stderr = await fs.readFile(stderrPath, { encoding: 'utf8' }).catch(() => '');

    if (Number.isNaN(exitCode) || exitCode !== 0) {
      throw new Error(
        `tmux worker failed with code=${Number.isNaN(exitCode) ? 'unknown' : exitCode} stderr=${stderr.slice(0, 400) || '(empty)'}`,
      );
    }

    return stdout.trim();
  }

  private resolveTaskTimeoutMs(task: TaskRecord) {
    if (!Number.isFinite(task.engineTimeoutMs)) {
      return this.config.ENGINE_TIMEOUT_MS;
    }
    return normalizeTimeoutMs(task.engineTimeoutMs, this.config.ENGINE_TIMEOUT_MS);
  }

  private async pathExists(targetPath: string) {
    return fs
      .access(targetPath)
      .then(() => true)
      .catch(() => false);
  }

  private isRepairableInfraError(message: string) {
    return REPAIRABLE_INFRA_ERROR_PATTERNS.some((pattern) => pattern.test(message));
  }

  private countInfraRepairAttempts(task: TaskRecord) {
    return task.events.filter((event) => event.kind === 'infra_repair_attempt').length;
  }

  private async ensureCommandAvailable(command: string, cwd: string) {
    if (!/^[a-zA-Z0-9._-]+$/.test(command)) {
      throw new Error(`unsupported_command_name:${command}`);
    }
    await execFileAsync('which', [command], {
      cwd,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
  }

  private async runWorkerPreflight(task: TaskRecord, worktreePath: string, forceDependencyInstall = false) {
    const details: string[] = [];
    await this.ensureCommandAvailable('git', worktreePath);
    await this.ensureCommandAvailable('node', worktreePath);
    await this.ensureCommandAvailable('npm', worktreePath);
    if (this.config.TASK_AUTO_PR) {
      await this.ensureCommandAvailable('gh', worktreePath);
    }

    const hasPackageJson = await this.pathExists(path.join(worktreePath, 'package.json'));
    if (!hasPackageJson) {
      return { repaired: false, details };
    }

    const hasNodeModules = await this.pathExists(path.join(worktreePath, 'node_modules'));
    if (hasNodeModules && !forceDependencyInstall) {
      details.push('node_modules already present');
      return { repaired: false, details };
    }

    const hasPackageLock = await this.pathExists(path.join(worktreePath, 'package-lock.json'));
    const npmArgs = hasPackageLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
    const timeoutMs = Math.max(60_000, Math.min(this.resolveTaskTimeoutMs(task), 5 * 60 * 1000));

    await execFileAsync('npm', npmArgs, {
      cwd: worktreePath,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    details.push(`ran npm ${npmArgs[0]} in worktree`);
    return { repaired: true, details };
  }

  private async tryCreateMissingPullRequest(task: TaskRecord, repo: RepoRegistration, worktreePath: string) {
    const existingPr = this.latestArtifact(task, 'pull_request')?.prUrl;
    const branch = task.branch || this.latestArtifact(task, 'launcher')?.branch;
    if (existingPr || !branch) {
      return undefined;
    }

    const commitSha = this.latestArtifact(task, 'git_commit')?.commitSha;
    if (!commitSha) {
      return undefined;
    }

    try {
      await this.github.pushBranch(worktreePath, repo.remote, branch);
      const prUrl = await this.github.openPullRequest(worktreePath, {
        title: `Task ${task.id}: ${task.text.slice(0, 80)}`,
        body: `Automated fallback PR creation for ${task.id}.`,
        base: repo.defaultBranch,
        head: branch,
      });
      this.appendArtifact(
        task,
        {
          kind: 'pull_request',
          at: new Date().toISOString(),
          prUrl,
          branch,
          summary: 'Opened pull request via fallback PR creation.',
        },
        false,
      );
      task.events.push({
        at: new Date().toISOString(),
        kind: 'pr_fallback_created',
        message: `Created missing pull request via fallback: ${prUrl}`,
      });
      return prUrl;
    } catch (error) {
      task.events.push({
        at: new Date().toISOString(),
        kind: 'pr_fallback_failed',
        message: `Fallback PR creation failed: ${stringifyUnknownError(error)}`,
      });
      return undefined;
    }
  }

  private parseEngineOutput(text: string): ParsedEngineOutput {
    const trimmed = text.trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    const firstDetectedPrUrl = extractGitHubPullRequestUrls(trimmed)[0];

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(candidate) as ParsedEngineOutput & Record<string, unknown>;
        const rawPrUrl =
          typeof parsed.prUrl === 'string'
            ? parsed.prUrl
            : typeof parsed.pullRequestUrl === 'string'
              ? parsed.pullRequestUrl
              : typeof parsed.url === 'string'
                ? parsed.url
                : '';
        const parsedPrUrl = extractGitHubPullRequestUrls(`${rawPrUrl} ${trimmed}`)[0];
        const parsedBranch =
          typeof parsed.branch === 'string'
            ? parsed.branch
            : typeof parsed.headRefName === 'string'
              ? parsed.headRefName
              : typeof parsed.headBranch === 'string'
                ? parsed.headBranch
                : '';
        if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
          return {
            summary: parsed.summary.trim(),
            state: parsed.state,
            commitMessage: parsed.commitMessage,
            prTitle: parsed.prTitle,
            prBody: parsed.prBody,
            testOutput: parsed.testOutput,
            prUrl: parsedPrUrl,
            branch: parsedBranch.trim() || undefined,
          };
        }
      } catch {
        // ignore and fall back to plain text
      }
    }

    return {
      summary: trimmed || 'Worker produced no output.',
      state: 'done',
      prUrl: firstDetectedPrUrl,
    };
  }

  private transitionTask(task: TaskRecord, input: TransitionInput) {
    const from = task.status;
    const to = input.to;
    let transitioned = false;

    if (from !== to) {
      if (!ALLOWED_TRANSITIONS[from]?.has(to)) {
        throw new Error(`invalid_task_transition:${from}->${to}`);
      }

      const at = new Date().toISOString();
      task.status = to;
      task.state = to;
      task.updatedAt = at;

      if (to === 'running' && !task.startedAt) {
        task.startedAt = at;
      }

      if (TERMINAL_STATUSES.has(to)) {
        task.finishedAt = at;
      } else if (to === 'queued') {
        task.finishedAt = undefined;
      }

      task.events.push({
        at,
        kind: 'status_transition',
        message: `${from} -> ${to}`,
        details: toEventDetails({ from, to }),
      });
      transitioned = true;
    }

    task.events.push({
      at: new Date().toISOString(),
      kind: input.kind,
      message: input.message,
      details: toEventDetails(input.details),
    });

    if (transitioned) {
      this.emitLifecycle(task, input.message);
    }
  }

  private appendArtifact(task: TaskRecord, artifact: TaskArtifact, secondary = false) {
    task.artifacts.push(artifact);
    if (!secondary) {
      task.artifact = artifact;
    }
  }

  private latestArtifact(task: TaskRecord, kind: TaskArtifact['kind']) {
    for (let index = task.artifacts.length - 1; index >= 0; index -= 1) {
      const artifact = task.artifacts[index];
      if (artifact.kind === kind) {
        return artifact;
      }
    }
    return undefined;
  }

  private hasCompletionArtifacts(task: TaskRecord) {
    return task.artifacts.some((artifact) =>
      artifact.kind === 'git_commit' ||
      artifact.kind === 'pull_request' ||
      artifact.kind === 'checks' ||
      artifact.kind === 'preview' ||
      artifact.kind === 'review_feedback' ||
      artifact.kind === 'file_changes' ||
      artifact.kind === 'test_output',
    );
  }

  private ensureNoArtifactState(task: TaskRecord, status: TaskStatus) {
    if (status !== 'done' && status !== 'running') {
      return;
    }

    if (status === 'done' && this.hasCompletionArtifacts(task)) {
      return;
    }

    const already = task.artifacts.some((artifact) => artifact.kind === 'no_artifact');
    if (already) {
      return;
    }

    this.appendArtifact(
      task,
      {
        kind: 'no_artifact',
        at: new Date().toISOString(),
        summary: `No concrete ${status} artifact recorded.`,
      },
      true,
    );
  }

  private buildProgressReport(task: TaskRecord): TaskProgressReport {
    this.ensureNoArtifactState(task, task.status);

    const launcher = this.latestArtifact(task, 'launcher');
    const commit = this.latestArtifact(task, 'git_commit');
    const pr = this.latestArtifact(task, 'pull_request');
    const checks = this.latestArtifact(task, 'checks');
    const preview = this.latestArtifact(task, 'preview');
    const review = this.latestArtifact(task, 'review_feedback');
    const files = this.latestArtifact(task, 'file_changes');
    const testOutput = this.latestArtifact(task, 'test_output');

    const evidence: TaskProgressReport['evidence'] = {
      assignedSession: task.assignedSession || launcher?.details?.assignedSession,
      branch: task.branch || launcher?.branch,
      worktreePath: task.worktreePath || launcher?.worktreePath,
      commitSha: commit?.commitSha,
      prUrl: pr?.prUrl,
      checksSummary: checks?.checksSummary,
      previewUrls: preview?.previewUrls,
      reviewSummary: review?.reviewSummary,
      reviewDecision: review?.reviewDecision,
      reviewComments: review?.reviewComments,
      changeRequests: review?.changeRequests,
      filesChanged: files?.filesChanged,
      testOutput: testOutput?.testOutput,
    };

    const runningEvidence = Boolean(evidence.assignedSession && evidence.branch && evidence.worktreePath);
    const completionEvidence = Boolean(
        evidence.commitSha ||
        evidence.prUrl ||
        (evidence.filesChanged && evidence.filesChanged.length > 0) ||
        evidence.checksSummary ||
        (evidence.previewUrls && evidence.previewUrls.length > 0) ||
        evidence.reviewSummary ||
        evidence.testOutput,
    );

    let artifactBacked = false;
    if (task.status === 'running') {
      artifactBacked = runningEvidence;
    } else if (task.status === 'done') {
      artifactBacked = completionEvidence;
    } else if (task.status === 'failed' || task.status === 'blocked') {
      artifactBacked = Boolean(task.error || this.latestArtifact(task, 'error'));
    }

    const artifactState = artifactBacked ? 'artifact-backed' : 'no-artifact';

    let message = `Task ${task.id} is ${task.status}.`;
    if (task.status === 'running') {
      message = artifactBacked
        ? `Task is running in ${evidence.worktreePath} on ${evidence.branch}.`
        : 'Task is running, but launcher artifacts are missing (no-artifact).';
    }
    if (task.status === 'blocked' && evidence.reviewSummary && task.error?.includes('review_feedback_required')) {
      message = `Task is blocked pending pull request review feedback. ${evidence.reviewSummary}`;
    }
    if (task.status === 'done') {
      if (artifactBacked && evidence.previewUrls?.length) {
        message = `Task is done with recorded completion artifacts and ${evidence.previewUrls.length} preview URL(s).`;
      } else {
        message = artifactBacked
          ? 'Task is done with recorded completion artifacts.'
          : 'Task is marked done, but no completion artifacts were recorded (no-artifact).';
      }
    }

    return {
      taskId: task.id,
      title: task.title,
      repoId: task.repoId,
      status: task.status,
      taskIntent: isTaskIntent(task.taskIntent) ? task.taskIntent : inferTaskIntent(task.text),
      requiredArtifacts: uniqueArtifacts(normalizeArtifactKinds(task.requiredArtifacts) || (task.requiresVerifiedPr ? ['pr'] : ['summary'])),
      artifactState,
      generatedAt: new Date().toISOString(),
      message,
      sourceContext: task.sourceContext,
      evidence,
    };
  }

  private toWorkItem(task: TaskRecord): WorkItemRecord {
    const report = this.buildProgressReport(task);
    const coordination = this.normalizeCoordination(task.coordination, task);
    return {
      id: task.id,
      taskId: task.id,
      title: task.title,
      text: task.text,
      source: task.source,
      status: task.status,
      repoId: task.repoId,
      taskIntent: report.taskIntent,
      requiredArtifacts: report.requiredArtifacts,
      sourceContext: task.sourceContext,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      blockedReason: task.status === 'blocked' ? task.error : undefined,
      coordination: {
        ...coordination,
        claimStatus: coordination.owner ? 'claimed' : 'unclaimed',
      },
      report,
    };
  }

  private emitLifecycle(task: TaskRecord, message: string) {
    if (this.lifecycleListeners.size === 0) {
      return;
    }

    const event: TaskLifecycleEvent = {
      type: TASK_EVENT_TYPE_BY_STATUS[task.status],
      taskId: task.id,
      status: task.status,
      repoId: task.repoId,
      sessionKey: task.sessionKey,
      at: new Date().toISOString(),
      message,
    };

    for (const listener of this.lifecycleListeners.values()) {
      try {
        listener(event);
      } catch {
        // ignore listener failures
      }
    }
  }

  private normalizeTask(raw: Partial<TaskRecord>): TaskRecord | null {
    if (!raw || typeof raw.id !== 'string' || !raw.id.trim()) {
      return null;
    }

    const now = new Date().toISOString();
    const status = isTaskStatus(raw.status) ? raw.status : isTaskStatus(raw.state) ? raw.state : 'queued';
    const assignedSession =
      typeof raw.assignedSession === 'string' && raw.assignedSession.trim()
        ? raw.assignedSession
        : typeof raw.workerSessionKey === 'string' && raw.workerSessionKey.trim()
          ? raw.workerSessionKey
          : this.launcher.assignedSession(typeof raw.repoId === 'string' ? raw.repoId : 'repo', raw.id, typeof raw.text === 'string' ? raw.text : '');

    const normalizedArtifacts = Array.isArray(raw.artifacts)
      ? raw.artifacts
          .map((artifact) => this.normalizeArtifact(artifact))
          .filter((artifact): artifact is TaskArtifact => Boolean(artifact))
      : [];

    const legacyArtifact = this.normalizeArtifact(raw.artifact);
    if (legacyArtifact && !normalizedArtifacts.some((artifact) => artifact.at === legacyArtifact.at && artifact.kind === legacyArtifact.kind)) {
      normalizedArtifacts.push(legacyArtifact);
    }

    const primaryArtifact = legacyArtifact || normalizedArtifacts[normalizedArtifacts.length - 1];
    const inferredTaskIntent = inferTaskIntent(typeof raw.text === 'string' ? raw.text : '');
    const requiresVerifiedPr =
      typeof raw.requiresVerifiedPr === 'boolean'
        ? raw.requiresVerifiedPr
        : inferredTaskIntent === 'implementation'
          ? this.config.CHAT_REQUIRE_VERIFIED_PR
          : false;

    return {
      id: raw.id,
      parentTaskId: typeof raw.parentTaskId === 'string' ? raw.parentTaskId : undefined,
      sessionKey: typeof raw.sessionKey === 'string' ? raw.sessionKey : undefined,
      source: raw.source === 'transport' || raw.source === 'webhook' || raw.source === 'operator' || raw.source === 'system' ? raw.source : 'operator',
      title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : buildTaskTitle(typeof raw.text === 'string' ? raw.text : ''),
      text: typeof raw.text === 'string' ? raw.text : '',
      repoId: typeof raw.repoId === 'string' ? raw.repoId : '',
      sourceContext: normalizeSourceContext(raw.sourceContext),
      targetRepoFullName:
        typeof raw.targetRepoFullName === 'string' && raw.targetRepoFullName.trim()
          ? raw.targetRepoFullName.trim()
          : undefined,
      engineTimeoutMs: Number.isFinite(raw.engineTimeoutMs)
        ? normalizeTimeoutMs(raw.engineTimeoutMs, this.config.ENGINE_TIMEOUT_MS)
        : undefined,
      coordination: this.normalizeCoordination(raw.coordination, {
        text: typeof raw.text === 'string' ? raw.text : '',
        title: typeof raw.title === 'string' ? raw.title : '',
        sourceContext: normalizeSourceContext(raw.sourceContext),
      }),
      taskIntent: isTaskIntent(raw.taskIntent) ? raw.taskIntent : inferredTaskIntent,
      requiresVerifiedPr,
      requiredArtifacts:
        normalizeArtifactKinds(Array.isArray(raw.requiredArtifacts) ? raw.requiredArtifacts : undefined) ||
        (requiresVerifiedPr ? ['pr'] : ['summary']),
      status,
      state: status,
      assignedSession,
      workerSessionKey: assignedSession,
      worktreePath: typeof raw.worktreePath === 'string' ? raw.worktreePath : typeof primaryArtifact?.worktreePath === 'string' ? primaryArtifact.worktreePath : undefined,
      branch: typeof raw.branch === 'string' ? raw.branch : typeof primaryArtifact?.branch === 'string' ? primaryArtifact.branch : undefined,
      retryCount: Number.isFinite(raw.retryCount) ? Number(raw.retryCount) : 0,
      maxRetries: Number.isFinite(raw.maxRetries) ? Number(raw.maxRetries) : this.config.WORKER_MAX_RETRIES,
      escalationRequired: Boolean(raw.escalationRequired),
      error: typeof raw.error === 'string' ? raw.error : undefined,
      artifacts: normalizedArtifacts,
      artifact: primaryArtifact,
      children: Array.isArray(raw.children) ? raw.children.filter((child): child is string => typeof child === 'string') : [],
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : undefined,
      finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : undefined,
      cancelRequested: Boolean(raw.cancelRequested),
      events: Array.isArray(raw.events)
        ? raw.events
            .filter((event): event is TaskRecord['events'][number] => Boolean(event && typeof event === 'object'))
            .map((event) => ({
              at: typeof event.at === 'string' ? event.at : now,
              kind: typeof event.kind === 'string' ? event.kind : 'unknown',
              message: typeof event.message === 'string' ? event.message : '',
              details: event.details,
            }))
        : [],
    };
  }

  private normalizeArtifact(raw: unknown): TaskArtifact | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const candidate = raw as Partial<TaskArtifact>;
    const at = typeof candidate.at === 'string' ? candidate.at : new Date().toISOString();
    const kind = this.inferArtifactKind(candidate);

    return {
      kind,
      at,
      summary: typeof candidate.summary === 'string' ? candidate.summary : undefined,
      worktreePath: typeof candidate.worktreePath === 'string' ? candidate.worktreePath : undefined,
      branch: typeof candidate.branch === 'string' ? candidate.branch : undefined,
      commitSha: typeof candidate.commitSha === 'string' ? candidate.commitSha : undefined,
      prUrl: typeof candidate.prUrl === 'string' ? candidate.prUrl : undefined,
      checksSummary: typeof candidate.checksSummary === 'string' ? candidate.checksSummary : undefined,
      checksPassed: typeof candidate.checksPassed === 'boolean' ? candidate.checksPassed : undefined,
      previewUrls: Array.isArray(candidate.previewUrls)
        ? candidate.previewUrls.filter((value): value is string => typeof value === 'string')
        : undefined,
      reviewSummary: typeof candidate.reviewSummary === 'string' ? candidate.reviewSummary : undefined,
      reviewDecision: typeof candidate.reviewDecision === 'string' ? candidate.reviewDecision : undefined,
      reviewComments: Number.isFinite(candidate.reviewComments) ? Number(candidate.reviewComments) : undefined,
      changeRequests: Number.isFinite(candidate.changeRequests) ? Number(candidate.changeRequests) : undefined,
      filesChanged: Array.isArray(candidate.filesChanged)
        ? candidate.filesChanged.filter((value): value is string => typeof value === 'string')
        : undefined,
      testOutput: typeof candidate.testOutput === 'string' ? candidate.testOutput : undefined,
      details: candidate.details,
    };
  }

  private inferArtifactKind(candidate: Partial<TaskArtifact>): TaskArtifact['kind'] {
    if (
      candidate.kind === 'launcher' ||
      candidate.kind === 'summary' ||
      candidate.kind === 'file_changes' ||
      candidate.kind === 'git_commit' ||
      candidate.kind === 'pull_request' ||
      candidate.kind === 'checks' ||
      candidate.kind === 'preview' ||
      candidate.kind === 'review_feedback' ||
      candidate.kind === 'test_output' ||
      candidate.kind === 'error' ||
      candidate.kind === 'no_artifact'
    ) {
      return candidate.kind;
    }

    if (candidate.commitSha) return 'git_commit';
    if (candidate.checksSummary || typeof candidate.checksPassed === 'boolean') return 'checks';
    if (candidate.previewUrls?.length) return 'preview';
    if (candidate.reviewSummary || typeof candidate.changeRequests === 'number') return 'review_feedback';
    if (candidate.prUrl) return 'pull_request';
    if (candidate.filesChanged?.length) return 'file_changes';
    if (candidate.testOutput) return 'test_output';
    if (candidate.worktreePath || candidate.branch) return 'launcher';
    if (candidate.summary) return 'summary';
    return 'no_artifact';
  }

  private async load() {
    await fs.mkdir(path.dirname(this.taskFile), { recursive: true });

    const raw = await fs.readFile(this.taskFile, { encoding: 'utf8' }).catch(() => '');
    if (!raw) {
      await this.persist();
      return;
    }

    try {
      const parsed = JSON.parse(raw) as TaskSnapshot;
      for (const item of parsed.tasks || []) {
        const task = this.normalizeTask(item as Partial<TaskRecord>);
        if (!task) continue;

        if (task.status === 'running' && this.config.TASK_RECOVER_ON_STARTUP) {
          this.transitionTask(task, {
            to: 'queued',
            kind: 'recovered',
            message: 'Recovered running task to queued state after restart.',
          });
        }

        this.tasks.set(task.id, task);
        if (task.status === 'queued') {
          this.queue.push(task.id);
        }
      }
    } catch {
      // reset corrupted state
      this.tasks.clear();
      this.queue.length = 0;
      await this.persist();
    }
  }

  private async persist() {
    const payload: TaskSnapshot = {
      version: 2,
      tasks: this.listTasks(),
    };

    const writeSnapshot = async () => {
      await fs.mkdir(path.dirname(this.taskFile), { recursive: true });
      const tmp = `${this.taskFile}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
      await fs.rename(tmp, this.taskFile);
    };

    try {
      await writeSnapshot();
      this.healthCache = undefined;
      return;
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') {
        throw error;
      }

      if (this.stopping) {
        return;
      }
    }

    await writeSnapshot();
    this.healthCache = undefined;
  }

  async stop() {
    this.stopping = true;
    const deadline = Date.now() + 5000;
    while (this.running.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private removeFromQueue(taskId: string) {
    let index = this.queue.indexOf(taskId);
    while (index >= 0) {
      this.queue.splice(index, 1);
      index = this.queue.indexOf(taskId);
    }
  }

  private async runMaintenance(force = false) {
    if (this.maintenanceInFlight) {
      return;
    }

    const nowMs = Date.now();
    if (!force && nowMs - this.lastMaintenanceAt < 60000) {
      return;
    }

    this.maintenanceInFlight = true;
    let dirty = false;

    try {
      const failedRetentionMs = this.config.FAILED_WORKTREE_RETENTION_HOURS * 60 * 60 * 1000;
      if (failedRetentionMs > 0) {
        for (const task of this.tasks.values()) {
          if (task.status !== 'failed' && task.status !== 'blocked') continue;
          if (!task.worktreePath || !task.finishedAt) continue;

          const finishedAtMs = Date.parse(task.finishedAt);
          if (!Number.isFinite(finishedAtMs) || nowMs - finishedAtMs < failedRetentionMs) continue;

          const repo = this.repoRegistry.get(task.repoId);
          if (repo) {
            await this.worktree.cleanupWorktree(repo, task.worktreePath, task.branch).catch(() => undefined);
          } else {
            await fs.rm(task.worktreePath, { recursive: true, force: true }).catch(() => undefined);
          }

          task.events.push({
            at: new Date().toISOString(),
            kind: 'cleanup_retention_expired',
            message: 'Failed worktree retention expired and was cleaned up.',
            details: toEventDetails({ worktreePath: task.worktreePath, branch: task.branch }),
          });
          task.updatedAt = new Date().toISOString();
          task.worktreePath = undefined;
          task.branch = undefined;
          dirty = true;
        }
      }

      const activeWorktreePaths = new Set(
        Array.from(this.tasks.values())
          .filter((task) => {
            if (task.status === 'queued' || task.status === 'running') return true;
            if ((task.status === 'failed' || task.status === 'blocked') && task.worktreePath) {
              if (!task.finishedAt) return true;
              const ageMs = nowMs - Date.parse(task.finishedAt);
              return ageMs < failedRetentionMs;
            }
            return false;
          })
          .map((task) => task.worktreePath)
          .filter((value): value is string => Boolean(value)),
      );
      await this.worktree.cleanupStale(this.config.WORKTREE_STALE_HOURS, activeWorktreePaths);

      if (this.config.WORKER_RUNTIME === 'tmux') {
        const activeWorkerSessions = new Set(
          Array.from(this.tasks.values())
            .filter((task) => task.status === 'running')
            .map((task) => task.assignedSession)
            .filter((value): value is string => Boolean(value)),
        );
        const sessionPrefix = `${this.config.WORKER_SESSION_PREFIX}-`;
        const tmuxSessions = await this.launcher.listTmuxSessions();
        for (const sessionName of tmuxSessions) {
          if (!sessionName.startsWith(sessionPrefix)) continue;
          if (activeWorkerSessions.has(sessionName)) continue;
          await this.launcher.killTmuxSession(sessionName).catch(() => undefined);
        }
      }
    } finally {
      this.lastMaintenanceAt = Date.now();
      this.maintenanceInFlight = false;
    }

    if (dirty) {
      await this.persist();
    }
  }
}
