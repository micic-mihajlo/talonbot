import type { TaskOrchestrator } from '../orchestration/task-orchestrator.js';
import type { RequiredArtifactKind, TaskProgressReport, TaskRecord, TaskStatus } from '../orchestration/types.js';
import type { TaskThreadBinding } from './store.js';
import { SessionStore } from './store.js';

export interface OutboundThreadMessage {
  channelId: string;
  threadId?: string;
  text: string;
  idempotencyKey?: string;
}

export type OutboundThreadSender = (message: OutboundThreadMessage) => Promise<void>;

type TransportSource = TaskThreadBinding['source'];

const TERMINAL = new Set<TaskStatus>(['done', 'failed', 'cancelled']);
const TRACKED_UPDATES = new Set<TaskStatus>(['running', 'blocked', 'done', 'failed', 'cancelled']);

const inferIntent = (task: TaskRecord): string => {
  if (task.taskIntent) {
    return task.taskIntent;
  }
  return 'unknown';
};

const inferRequiredArtifacts = (task: TaskRecord): RequiredArtifactKind[] => {
  if (task.requiredArtifacts?.length) {
    return task.requiredArtifacts;
  }
  if (typeof task.requiresVerifiedPr === 'boolean') {
    return task.requiresVerifiedPr ? ['pr'] : ['summary'];
  }
  return ['summary'];
};

const hasArtifact = (task: TaskRecord, artifact: 'summary' | 'branch' | 'commit' | 'pr') => {
  const artifacts = task.artifacts || [];
  if (artifact === 'summary') {
    return artifacts.some((item) => item.kind === 'summary');
  }
  if (artifact === 'branch') {
    return Boolean(task.branch || artifacts.some((item) => item.kind === 'launcher' && !!item.branch));
  }
  if (artifact === 'commit') {
    return artifacts.some((item) => item.kind === 'git_commit');
  }
  if (artifact === 'pr') {
    return artifacts.some((item) => item.kind === 'pull_request');
  }
  return false;
};

const missingArtifacts = (task: TaskRecord) => {
  return inferRequiredArtifacts(task).filter((artifact) => !hasArtifact(task, artifact));
};

const describeTaskRequirements = (task: TaskRecord) => {
  const intent = inferIntent(task);
  const required = inferRequiredArtifacts(task);
  return `intent=${intent}, required=${required.length ? required.join('/') : 'none'}`;
};

const statusMessage = (task: TaskRecord, report: TaskProgressReport | null) => {
  const evidence: string[] = [];
  if (report?.evidence.prUrl) evidence.push(`PR ${report.evidence.prUrl}`);
  if (report?.evidence.commitSha) evidence.push(`commit ${report.evidence.commitSha}`);
  if (report?.evidence.checksSummary) evidence.push(`checks ${report.evidence.checksSummary}`);
  if (report?.evidence.branch) evidence.push(`branch ${report.evidence.branch}`);
  const evidenceLine = evidence.length > 0 ? ` Evidence: ${evidence.join(' | ')}.` : '';

  if (task.status === 'running') {
    return `Task ${task.id} is running (worker session: ${task.assignedSession || 'n/a'}).`;
  }

  if (task.status === 'blocked') {
    if (task.requiresVerifiedPr && task.error?.includes('verified_pr_required')) {
      return `Task ${task.id} blocked for policy compliance (${describeTaskRequirements(task)}). Blocked pending verified PR URL.${evidenceLine}`;
    }

    const missing = missingArtifacts(task);
    if (missing.length > 0) {
      return `Task ${task.id} blocked for policy compliance (${describeTaskRequirements(task)}). Missing required artifacts: ${missing.join(', ')}.${evidenceLine}`;
    }

    return `Task ${task.id} is blocked. ${report?.message || task.error || 'Operator action is required.'} (${describeTaskRequirements(task)})${evidenceLine}`;
  }

  if (task.status === 'done') {
    const missing = missingArtifacts(task);
    if (missing.length > 0) {
      return `Task ${task.id} has no terminal completion evidence yet (${describeTaskRequirements(task)}). Missing required artifacts: ${missing.join(', ')}.${evidenceLine}`;
    }
    return `Task ${task.id} completed with required artifacts (${describeTaskRequirements(task)}).${evidenceLine}`;
  }

  if (task.status === 'failed') {
    return `Task ${task.id} failed. ${report?.message || task.error || 'Execution failed.'}${evidenceLine}`;
  }

  return `Task ${task.id} cancelled.${evidenceLine}`;
};

export class TaskUpdateNotifier {
  private readonly bindings = new Map<string, TaskThreadBinding>();
  private readonly inFlight = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private unsubLifecycle?: () => void;
  private stopping = false;

  constructor(
    private readonly store: SessionStore,
    private readonly tasks: TaskOrchestrator,
    private readonly getSender: (source: TransportSource) => OutboundThreadSender | undefined,
    private readonly pollMs: number,
    private readonly logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  ) {}

  async initialize() {
    const existing = await this.store.readTaskBindings();
    for (const binding of existing) {
      this.bindings.set(binding.taskId, binding);
    }
    const snapshot =
      typeof (this.tasks as unknown as { listTasks?: () => TaskRecord[] }).listTasks === 'function'
        ? (this.tasks as unknown as { listTasks: () => TaskRecord[] }).listTasks()
        : [];
    await this.store.pruneTaskBindings(snapshot);
    await this.reloadBindings();
    for (const binding of this.bindings.values()) {
      const task = this.tasks.getTask(binding.taskId);
      if (!task) {
        continue;
      }
      if (binding.lastNotifiedStatus && binding.lastNotifiedStatus !== task.status) {
        binding.lastNotifiedStatus = undefined;
        binding.lastNotifiedAt = undefined;
        await this.store.upsertTaskBinding(binding);
      }
    }

    const lifecycleCapable = this.tasks as unknown as {
      onLifecycle?: (listener: (event: { taskId: string; at?: string }) => void) => () => void;
    };
    if (typeof lifecycleCapable.onLifecycle === 'function') {
      this.unsubLifecycle = lifecycleCapable.onLifecycle((event) => {
        void this.publish(event.taskId, 'event', event.at);
      });
    }

    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);

    await this.poll();
  }

  async stop() {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.unsubLifecycle) {
      this.unsubLifecycle();
      this.unsubLifecycle = undefined;
    }
    const deadline = Date.now() + Math.max(500, this.pollMs * 2);
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  listBindings() {
    return Array.from(this.bindings.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async track(binding: TaskThreadBinding) {
    const normalized: TaskThreadBinding = {
      ...binding,
      createdAt: binding.createdAt || new Date().toISOString(),
    };
    this.bindings.set(normalized.taskId, normalized);
    await this.store.upsertTaskBinding(normalized);
  }

  private async reloadBindings() {
    const refreshed = await this.store.readTaskBindings();
    this.bindings.clear();
    for (const binding of refreshed) {
      this.bindings.set(binding.taskId, binding);
    }
  }

  private async poll() {
    for (const taskId of Array.from(this.bindings.keys())) {
      await this.publish(taskId, 'poll');
    }
  }

  private async publish(taskId: string, mode: 'event' | 'poll', lifecycleAt?: string) {
    if (this.stopping) {
      return;
    }
    if (this.inFlight.has(taskId)) {
      return;
    }
    this.inFlight.add(taskId);

    try {
      const binding = this.bindings.get(taskId);
      if (!binding) {
        return;
      }

      const task = this.tasks.getTask(taskId);
      if (!task) {
        await this.removeBinding(taskId);
        return;
      }

      if (!TRACKED_UPDATES.has(task.status)) {
        return;
      }

      if (binding.lastNotifiedStatus === task.status) {
        if (TERMINAL.has(task.status)) {
          await this.removeBinding(taskId);
        }
        return;
      }

      const sender = this.getSender(binding.source);
      if (!sender) {
        this.logger.warn('task update sender unavailable', { taskId, source: binding.source, mode });
        return;
      }

      const report = this.tasks.buildTaskReport(task.id);
      const text = statusMessage(task, report);
      const idempotencyKey = [
        'task-update',
        task.id,
        task.status,
        lifecycleAt || task.updatedAt || report?.generatedAt || new Date().toISOString(),
      ].join(':');
      await sender({
        channelId: binding.channelId,
        threadId: binding.threadId,
        text,
        idempotencyKey,
      });

      const at = new Date().toISOString();
      binding.lastNotifiedStatus = task.status;
      binding.lastNotifiedAt = at;
      await this.store.upsertTaskBinding(binding);

      if (TERMINAL.has(task.status)) {
        await this.removeBinding(taskId);
      }
    } catch (error) {
      this.logger.warn('task update publish failed', {
        taskId,
        mode,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  private async removeBinding(taskId: string) {
    this.bindings.delete(taskId);
    await this.store.removeTaskBinding(taskId).catch(() => undefined);
  }
}
