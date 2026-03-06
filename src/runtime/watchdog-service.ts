import type { AppConfig } from '../config.js';
import { SentryAgent, type SentryIncident } from '../orchestration/sentry-agent.js';
import type { TaskOrchestrator } from '../orchestration/task-orchestrator.js';

export class WatchdogService {
  private agent?: SentryAgent;
  private initialized = false;
  private running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly tasks: TaskOrchestrator,
    private readonly onEscalation: (incident: SentryIncident) => Promise<void>,
  ) {}

  async initialize() {
    if (this.initialized || !this.config.SENTRY_ENABLED) {
      this.initialized = true;
      return;
    }
    this.agent = new SentryAgent({
      pollMs: this.config.SENTRY_POLL_MS,
      stateFile: this.config.SENTRY_STATE_FILE,
      listTasks: () => this.tasks.listTasks(),
      onEscalation: this.onEscalation,
    });
    await this.agent.initialize();
    this.initialized = true;
  }

  async start() {
    await this.initialize();
    if (!this.agent) {
      return false;
    }
    if (!this.running) {
      this.agent.start();
      this.running = true;
    }
    return true;
  }

  async stop() {
    if (!this.agent || !this.running) {
      return false;
    }
    this.agent.stop();
    this.running = false;
    return true;
  }

  isRunning() {
    return this.running;
  }

  getStatus() {
    return this.agent?.getStatus() || {
      scans: 0,
      trackedTasks: 0,
      incidents: 0,
      lastIncidentAt: null,
    };
  }

  listIncidents(limit = 100) {
    return this.agent?.listIncidents(limit) || [];
  }
}
