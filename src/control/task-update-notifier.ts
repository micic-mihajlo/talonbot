import type { TaskOrchestrator } from '../orchestration/task-orchestrator.js';
import type { TaskProgressReport, TaskRecord, TaskStatus } from '../orchestration/types.js';
import type { TaskThreadBinding } from './store.js';
import { SessionStore } from './store.js';

export interface OutboundThreadMessage {
  channelId: string;
  threadId?: string;
  text: string;
}

export type OutboundThreadSender = (message: OutboundThreadMessage) => Promise<void>;

type TransportSource = TaskThreadBinding['source'];

const TERMINAL = new Set<TaskStatus>(['done', 'failed', 'cancelled']);
const TRACKED_UPDATES = new Set<TaskStatus>(['running', 'blocked', 'done', 'failed', 'cancelled']);

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
    return `Task ${task.id} is blocked. ${report?.message || task.error || 'Operator action is required.'}${evidenceLine}`;
  }

  if (task.status === 'done') {
    return `Task ${task.id} completed with verified artifacts.${evidenceLine}`;
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

    const maybeSubscribe = (this.tasks as unknown as {
      onLifecycle?: (listener: (event: { taskId: string }) => void) => () => void;
    }).onLifecycle;
    if (typeof maybeSubscribe === 'function') {
      this.unsubLifecycle = maybeSubscribe((event) => {
        void this.publish(event.taskId, 'event');
      });
    }

    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollMs);

    await this.poll();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.unsubLifecycle) {
      this.unsubLifecycle();
      this.unsubLifecycle = undefined;
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

  private async publish(taskId: string, mode: 'event' | 'poll') {
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
      await sender({
        channelId: binding.channelId,
        threadId: binding.threadId,
        text,
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
