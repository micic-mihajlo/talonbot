import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskRecord } from './types.js';

export interface SentryIncident {
  taskId: string;
  repoId: string;
  state: TaskRecord['state'];
  error?: string;
  createdAt: string;
  updatedAt: string;
  detectedAt: string;
}

interface SentryAgentOptions {
  pollMs: number;
  stateFile: string;
  listTasks: () => TaskRecord[];
  onEscalation?: (incident: SentryIncident) => Promise<void>;
}

export class SentryAgent {
  private timer?: ReturnType<typeof setInterval>;
  private readonly seen = new Set<string>();
  private readonly incidents: SentryIncident[] = [];
  private scans = 0;

  constructor(private readonly options: SentryAgentOptions) {}

  async initialize() {
    await fs.mkdir(path.dirname(this.options.stateFile), { recursive: true });
    const raw = await fs.readFile(this.options.stateFile, { encoding: 'utf8' }).catch(() => '');
    if (!raw) return;

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const incident = JSON.parse(trimmed) as SentryIncident;
        if (incident.taskId) {
          this.seen.add(incident.taskId);
          this.incidents.push(incident);
        }
      } catch {
        // ignore malformed lines and continue
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.scan();
    }, this.options.pollMs);
    void this.scan();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async scan() {
    this.scans += 1;
    const tasks = this.options.listTasks();

    for (const task of tasks) {
      if (!task.escalationRequired) continue;
      if (task.state !== 'failed' && task.state !== 'blocked') continue;
      if (this.seen.has(task.id)) continue;

      const incident: SentryIncident = {
        taskId: task.id,
        repoId: task.repoId,
        state: task.state,
        error: task.error,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        detectedAt: new Date().toISOString(),
      };

      this.seen.add(task.id);
      this.incidents.push(incident);
      await this.appendIncident(incident);

      if (this.options.onEscalation) {
        await this.options.onEscalation(incident).catch(() => undefined);
      }
    }
  }

  getStatus() {
    const latest = this.incidents[this.incidents.length - 1];
    return {
      scans: this.scans,
      trackedTasks: this.seen.size,
      incidents: this.incidents.length,
      lastIncidentAt: latest?.detectedAt || null,
    };
  }

  listIncidents(limit = 100) {
    return this.incidents.slice(Math.max(0, this.incidents.length - limit));
  }

  private async appendIncident(incident: SentryIncident) {
    const line = `${JSON.stringify(incident)}\n`;
    await fs.appendFile(this.options.stateFile, line, { encoding: 'utf8' });
  }
}
