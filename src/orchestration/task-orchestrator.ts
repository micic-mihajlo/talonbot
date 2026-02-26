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
  TaskRecord,
  TaskSnapshot,
} from './types.js';
import { RepoRegistry } from './repo-registry.js';
import { WorktreeManager } from './worktree-manager.js';
import { GitHubAutomation } from './github-automation.js';
import { TeamMemory } from '../memory/team-memory.js';

const randomId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

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

interface ParsedEngineOutput {
  summary: string;
  state?: 'done' | 'blocked';
  commitMessage?: string;
  prTitle?: string;
  prBody?: string;
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

  constructor(private readonly config: AppConfig) {
    const dataDir = config.DATA_DIR.replace('~', process.env.HOME || '');
    this.taskFile = path.join(dataDir, 'tasks', 'state.json');
    this.repoRegistry = new RepoRegistry(path.join(dataDir, 'repos', 'registry.json'));
    this.worktree = new WorktreeManager(config.WORKTREE_ROOT_DIR);
    this.memory = new TeamMemory(path.join(dataDir, 'memory'));
    this.engine = buildEngine(config);
  }

  async initialize() {
    await this.repoRegistry.initialize();
    await this.worktree.initialize();
    await this.memory.initialize();
    await this.memory.prune();
    await this.worktree.cleanupStale(this.config.WORKTREE_STALE_HOURS);
    await this.load();
    this.pump();
  }

  listTasks() {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getTask(taskId: string) {
    return this.tasks.get(taskId) || null;
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

    if (task.state === 'running') {
      throw new Error('task_running');
    }

    task.state = 'queued';
    task.error = undefined;
    task.escalationRequired = false;
    task.updatedAt = new Date().toISOString();
    task.events.push({
      at: task.updatedAt,
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

    if (task.state === 'queued') {
      task.state = 'cancelled';
      task.updatedAt = new Date().toISOString();
      task.finishedAt = task.updatedAt;
      this.removeFromQueue(taskId);
      await this.persist();
      return true;
    }

    if (task.state === 'running') {
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
      state: 'blocked',
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
    state?: TaskRecord['state'];
  }): TaskRecord {
    const now = new Date().toISOString();
    return {
      id: randomId('task'),
      parentTaskId: input.parentTaskId,
      sessionKey: input.sessionKey,
      source: input.source,
      text: input.text,
      repoId: input.repoId,
      state: input.state || 'queued',
      workerSessionKey: randomId('dev-agent'),
      retryCount: 0,
      maxRetries: this.config.WORKER_MAX_RETRIES,
      escalationRequired: false,
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

    while (this.running.size < this.config.TASK_MAX_CONCURRENCY && this.queue.length > 0) {
      const taskId = this.queue.shift();
      if (!taskId) break;

      const task = this.tasks.get(taskId);
      if (!task || task.state !== 'queued') {
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
    const startedAt = new Date().toISOString();
    task.state = 'running';
    task.startedAt = startedAt;
    task.updatedAt = startedAt;
    task.events.push({ at: startedAt, kind: 'started', message: 'Worker started.' });
    await this.persist();

    let worktreePath = '';
    let branch = '';
    let repo: RepoRegistration | null = null;

    try {
      repo = this.resolveRepo(task.repoId);
      const worktreeInfo = await this.worktree.createWorktree(repo, task.id);
      worktreePath = worktreeInfo.path;
      branch = worktreeInfo.branch;

      const memoryContext = await this.memory.readBootContext();
      const engineOutput = await this.engine.complete({
        sessionKey: task.workerSessionKey,
        route: `task:${task.id}`,
        text: this.buildWorkerPrompt(task.text, repo.path, worktreePath, memoryContext),
        senderId: 'control-agent',
        metadata: {
          taskId: task.id,
          repoId: repo.id,
        },
        contextLines: [],
        rawEvent: buildSyntheticEvent(task.workerSessionKey, task.text),
        recentAttachments: [],
      });

      if (task.cancelRequested) {
        task.state = 'cancelled';
        task.finishedAt = new Date().toISOString();
        task.updatedAt = task.finishedAt;
        task.events.push({
          at: task.finishedAt,
          kind: 'cancelled',
          message: 'Task cancelled after current step completed.',
        });
        await this.persist();
        return;
      }

      const parsed = this.parseEngineOutput(engineOutput.text);

      if (parsed.state === 'blocked') {
        task.state = 'blocked';
        task.error = parsed.summary;
        task.updatedAt = new Date().toISOString();
        task.events.push({
          at: task.updatedAt,
          kind: 'blocked',
          message: parsed.summary,
        });
        await this.persist();
        return;
      }

      const artifact: TaskArtifact = {
        summary: parsed.summary,
        worktreePath,
        branch,
      };

      if (this.config.TASK_AUTO_COMMIT) {
        const commitSha = await this.github.commitAll(worktreePath, parsed.commitMessage || `task(${task.id}): automated update`);
        artifact.commitSha = commitSha || undefined;

        if (commitSha && this.config.TASK_AUTO_PR) {
          await this.github.pushBranch(worktreePath, repo.remote, branch);
          const prUrl = await this.github.openPullRequest(worktreePath, {
            title: parsed.prTitle || `Task ${task.id}: ${task.text.slice(0, 80)}`,
            body: parsed.prBody || `Automated task execution for ${task.id}.`,
            base: repo.defaultBranch,
            head: branch,
          });
          artifact.prUrl = prUrl;
          const checks = await this.github
            .waitForPullRequestChecks(worktreePath, prUrl, {
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
          artifact.checksSummary = checks.summary;
          artifact.checksPassed = checks.passed;

          if (!checks.passed) {
            task.artifact = artifact;
            task.state = 'blocked';
            task.escalationRequired = true;
            task.error = `PR checks did not pass: ${checks.summary}`;
            task.updatedAt = new Date().toISOString();
            task.finishedAt = task.updatedAt;
            task.events.push({
              at: task.updatedAt,
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

      task.artifact = artifact;
      task.state = 'done';
      task.finishedAt = new Date().toISOString();
      task.updatedAt = task.finishedAt;
      task.events.push({
        at: task.finishedAt,
        kind: 'completed',
        message: artifact.summary,
        details: artifact.prUrl
          ? {
              prUrl: artifact.prUrl,
            }
          : undefined,
      });

      await this.memory.recordTaskCompletion({
        taskId: task.id,
        repoId: repo.id,
        state: task.state,
        summary: artifact.summary,
      });

      await this.persist();
      this.updateParentState(task);
    } catch (error) {
      task.retryCount += 1;
      task.updatedAt = new Date().toISOString();
      task.error = error instanceof Error ? error.message : String(error);

      if (task.retryCount <= task.maxRetries) {
        task.state = 'queued';
        task.events.push({
          at: task.updatedAt,
          kind: 'retry_scheduled',
          message: `Worker failed: ${task.error}. Retry ${task.retryCount}/${task.maxRetries}.`,
        });
        this.queue.push(task.id);
      } else {
        task.state = 'failed';
        task.finishedAt = task.updatedAt;
        task.escalationRequired = true;
        task.events.push({
          at: task.updatedAt,
          kind: 'failed',
          message: `Worker failed permanently after ${task.retryCount} attempts: ${task.error}.`,
        });
      }

      await this.persist();
      this.updateParentState(task);
    } finally {
      if (this.config.TASK_AUTOCLEANUP && worktreePath && repo) {
        await this.worktree.cleanupWorktree(repo, worktreePath, branch).catch(() => undefined);
      }
    }
  }

  private updateParentState(task: TaskRecord) {
    if (!task.parentTaskId) return;
    const parent = this.tasks.get(task.parentTaskId);
    if (!parent) return;

    const children = parent.children
      .map((taskId) => this.tasks.get(taskId))
      .filter((item): item is TaskRecord => Boolean(item));

    if (children.some((child) => child.state === 'failed')) {
      parent.state = 'failed';
      parent.updatedAt = new Date().toISOString();
      parent.finishedAt = parent.updatedAt;
      parent.error = 'One or more fan-out tasks failed.';
      parent.escalationRequired = true;
      void this.persist();
      return;
    }

    if (children.every((child) => child.state === 'done')) {
      parent.state = 'done';
      parent.updatedAt = new Date().toISOString();
      parent.finishedAt = parent.updatedAt;
      parent.artifact = {
        summary: `All ${children.length} child tasks completed.`,
      };
      void this.persist();
      return;
    }

    parent.state = 'blocked';
    parent.updatedAt = new Date().toISOString();
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
      '{"summary":"short summary","state":"done|blocked","commitMessage":"optional","prTitle":"optional","prBody":"optional"}',
      '',
      'Team memory context:',
      memoryContext || '(none)',
    ].join('\n');
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

  private async load() {
    await fs.mkdir(path.dirname(this.taskFile), { recursive: true });

    const raw = await fs.readFile(this.taskFile, { encoding: 'utf8' }).catch(() => '');
    if (!raw) {
      await this.persist();
      return;
    }

    try {
      const parsed = JSON.parse(raw) as TaskSnapshot;
      for (const task of parsed.tasks || []) {
        if (task.state === 'running') {
          task.state = 'queued';
          task.events.push({
            at: new Date().toISOString(),
            kind: 'recovered',
            message: 'Recovered running task to queued state after restart.',
          });
        }

        this.tasks.set(task.id, task);
        if (task.state === 'queued') {
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
    await fs.mkdir(path.dirname(this.taskFile), { recursive: true });

    const payload: TaskSnapshot = {
      tasks: this.listTasks(),
    };

    const tmp = `${this.taskFile}.${Date.now()}-${Math.random().toString(16).slice(2, 8)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
    await fs.rename(tmp, this.taskFile);
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
}
