import fs from 'node:fs/promises';
import path from 'node:path';
import { buildEngine } from '../engine/index.js';
import type { AgentEngine } from '../engine/types.js';
import type { AppConfig } from '../config.js';
import type {
  RepoRegistration,
  RepoRegistrationInput,
  SubmitTaskInput,
  TaskArtifact,
  TaskProgressReport,
  TaskRecord,
  TaskSnapshot,
  TaskStatus,
} from './types.js';
import { RepoRegistry } from './repo-registry.js';
import { WorktreeManager } from './worktree-manager.js';
import { GitHubAutomation } from './github-automation.js';
import { TeamMemory } from '../memory/team-memory.js';
import { WorkerLauncher } from './worker-launcher.js';
import { OrchestrationHealthMonitor, type OrchestrationHealthSnapshot } from './health-monitor.js';

const randomId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

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

const isTaskStatus = (value: unknown): value is TaskStatus =>
  value === 'queued' || value === 'running' || value === 'blocked' || value === 'done' || value === 'failed' || value === 'cancelled';

const buildSyntheticEvent = (sessionKey: string, text: string) => ({
  id: randomId('task-event'),
  source: 'socket' as const,
  sourceChannelId: sessionKey,
  sourceMessageId: randomId('task-message'),
  senderId: 'control-agent',
  senderName: 'control-agent',
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

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

interface ParsedEngineOutput {
  summary: string;
  state?: 'done' | 'blocked';
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
  testOutput?: string;
}

interface TransitionInput {
  to: TaskStatus;
  kind: string;
  message: string;
  details?: Record<string, unknown>;
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
    this.memory = new TeamMemory(path.join(dataDir, 'memory'));
    this.engine = buildEngine(config, 'orchestrator');
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

  async submitTask(input: SubmitTaskInput) {
    const source = input.source || 'operator';

    if (input.fanout?.length) {
      return this.submitFanout(input);
    }

    const repo = this.resolveRepo(input.repoId);
    const task = this.createTask({
      source,
      text: input.text,
      repoId: repo.id,
      sessionKey: input.sessionKey,
      parentTaskId: input.parentTaskId,
    });

    this.tasks.set(task.id, task);
    this.queue.push(task.id);
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
      repoId: repo.id,
      sessionKey: input.sessionKey,
      parentTaskId: input.parentTaskId,
      status: 'blocked',
    });

    this.tasks.set(parent.id, parent);

    for (const childPrompt of fanout) {
      const child = this.createTask({
        source: input.source || 'operator',
        text: childPrompt,
        repoId: repo.id,
        sessionKey: input.sessionKey,
        parentTaskId: parent.id,
      });
      parent.children.push(child.id);
      this.tasks.set(child.id, child);
      this.queue.push(child.id);
    }

    await this.persist();
    this.pump();
    return parent;
  }

  private createTask(input: {
    source: TaskRecord['source'];
    text: string;
    repoId: string;
    sessionKey?: string;
    parentTaskId?: string;
    status?: TaskStatus;
  }): TaskRecord {
    const now = new Date().toISOString();
    const id = randomId('task');
    const status = input.status || 'queued';
    const assignedSession = this.launcher.assignedSession(input.repoId, id, input.text);

    return {
      id,
      parentTaskId: input.parentTaskId,
      sessionKey: input.sessionKey,
      source: input.source,
      text: input.text,
      repoId: input.repoId,
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

      const memoryContext = await this.memory.readBootContext();
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

      if (parsed.state === 'blocked') {
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
        }
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
      task.retryCount += 1;
      task.updatedAt = new Date().toISOString();
      task.error = error instanceof Error ? error.message : String(error);
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

  private buildWorkerPrompt(taskText: string, repoPath: string, worktreePath: string, memoryContext: string) {
    return [
      'You are a task-scoped dev worker.',
      `Task: ${taskText}`,
      `Repo path: ${repoPath}`,
      `Worktree path: ${worktreePath}`,
      '',
      'Return JSON only:',
      '{"summary":"short summary","state":"done|blocked","commitMessage":"optional","prTitle":"optional","prBody":"optional","testOutput":"optional"}',
      '',
      'Team memory context:',
      memoryContext || '(none)',
    ].join('\n');
  }

  private async runWorkerTurn(task: TaskRecord, repo: RepoRegistration, worktreePath: string, memoryContext: string) {
    const prompt = this.buildWorkerPrompt(task.text, repo.path, worktreePath, memoryContext);
    if (this.config.WORKER_RUNTIME === 'tmux') {
      return this.runWorkerTurnViaTmux(task, repo, worktreePath, prompt);
    }

    const output = await this.engine.complete({
      sessionKey: task.assignedSession,
      route: `task:${task.id}`,
      text: prompt,
      senderId: 'control-agent',
      metadata: {
        taskId: task.id,
        repoId: repo.id,
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
      sender: 'control-agent',
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

    const script = [
      '#!/usr/bin/env bash',
      'set -uo pipefail',
      `PAYLOAD=$(cat ${shellQuote(payloadPath)})`,
      `OUT=${shellQuote(stdoutPath)}`,
      `ERR=${shellQuote(stderrPath)}`,
      `EXIT=${shellQuote(exitPath)}`,
      'set +e',
      `if [ -n ${shellQuote(this.config.ENGINE_ARGS)} ]; then`,
      `  eval ${shellQuote(`"${this.config.ENGINE_COMMAND}" ${this.config.ENGINE_ARGS} "$PAYLOAD"`)} >"$OUT" 2>"$ERR"`,
      'else',
      `  ${shellQuote(this.config.ENGINE_COMMAND)} "$PAYLOAD" >"$OUT" 2>"$ERR"`,
      'fi',
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

    const deadline = Date.now() + this.config.ENGINE_TIMEOUT_MS;
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

  private parseEngineOutput(text: string): ParsedEngineOutput {
    const trimmed = text.trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(candidate) as ParsedEngineOutput;
        if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
          return {
            summary: parsed.summary.trim(),
            state: parsed.state,
            commitMessage: parsed.commitMessage,
            prTitle: parsed.prTitle,
            prBody: parsed.prBody,
            testOutput: parsed.testOutput,
          };
        }
      } catch {
        // ignore and fall back to plain text
      }
    }

    return {
      summary: trimmed || 'Worker produced no output.',
      state: 'done',
    };
  }

  private transitionTask(task: TaskRecord, input: TransitionInput) {
    const from = task.status;
    const to = input.to;

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
    }

    task.events.push({
      at: new Date().toISOString(),
      kind: input.kind,
      message: input.message,
      details: toEventDetails(input.details),
    });
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
    const files = this.latestArtifact(task, 'file_changes');
    const testOutput = this.latestArtifact(task, 'test_output');

    const evidence: TaskProgressReport['evidence'] = {
      assignedSession: task.assignedSession || launcher?.details?.assignedSession,
      branch: task.branch || launcher?.branch,
      worktreePath: task.worktreePath || launcher?.worktreePath,
      commitSha: commit?.commitSha,
      prUrl: pr?.prUrl,
      checksSummary: checks?.checksSummary,
      filesChanged: files?.filesChanged,
      testOutput: testOutput?.testOutput,
    };

    const runningEvidence = Boolean(evidence.assignedSession && evidence.branch && evidence.worktreePath);
    const completionEvidence = Boolean(
      evidence.commitSha ||
        evidence.prUrl ||
        (evidence.filesChanged && evidence.filesChanged.length > 0) ||
        evidence.checksSummary ||
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
    if (task.status === 'done') {
      message = artifactBacked
        ? 'Task is done with recorded completion artifacts.'
        : 'Task is marked done, but no completion artifacts were recorded (no-artifact).';
    }

    return {
      taskId: task.id,
      status: task.status,
      artifactState,
      generatedAt: new Date().toISOString(),
      message,
      evidence,
    };
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

    return {
      id: raw.id,
      parentTaskId: typeof raw.parentTaskId === 'string' ? raw.parentTaskId : undefined,
      sessionKey: typeof raw.sessionKey === 'string' ? raw.sessionKey : undefined,
      source: raw.source === 'transport' || raw.source === 'webhook' || raw.source === 'operator' || raw.source === 'system' ? raw.source : 'operator',
      text: typeof raw.text === 'string' ? raw.text : '',
      repoId: typeof raw.repoId === 'string' ? raw.repoId : '',
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
      candidate.kind === 'test_output' ||
      candidate.kind === 'error' ||
      candidate.kind === 'no_artifact'
    ) {
      return candidate.kind;
    }

    if (candidate.commitSha) return 'git_commit';
    if (candidate.prUrl) return 'pull_request';
    if (candidate.checksSummary || typeof candidate.checksPassed === 'boolean') return 'checks';
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

        if (task.status === 'running') {
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
