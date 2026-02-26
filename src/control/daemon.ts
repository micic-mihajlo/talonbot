import { AgentSession } from './session';
import { routeFromMessage } from './route';
import { SessionStore } from './store';
import type { RunnerCallbacks, InboundMessage } from '../shared/protocol';
import { buildEngine } from '../engine';
import type { AppConfig } from '../config';

export interface DispatchResult {
  accepted: boolean;
  reason?: string;
  sessionKey?: string;
}

interface RunnerContext {
  reply: (text: string) => Promise<void>;
}

const STOP_COMMANDS = new Set(['!stop', '/stop', 'stop', '!shutdown', '/shutdown', 'shutdown']);
const STATUS_COMMANDS = new Set(['!status', '/status', 'status']);

export class ControlPlane {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly store: SessionStore;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: AppConfig, private readonly engineFactory = buildEngine) {
    const expandedPath = this.config.DATA_DIR.replace('~', process.env.HOME || '');
    this.store = new SessionStore(expandedPath + '/sessions');
  }

  async initialize() {
    await this.store.init();
    this.startCleanupTimer();
  }

  async dispatch(message: InboundMessage, callbacks: RunnerContext): Promise<DispatchResult> {
    const route = routeFromMessage(message);
    const normalized = message.text.trim();

    if (this.isStatusCommand(normalized)) {
      const current = this.sessions.get(route.sessionKey);
      const status = current
        ? `session=${route.sessionKey} active queue=${current.queueSize} last=${current.lastActiveAt}`
        : `session=${route.sessionKey} inactive`;
      await callbacks.reply(status);
      return {
        accepted: true,
        reason: 'status_report',
        sessionKey: route.sessionKey,
      };
    }

    if (this.isStopCommand(normalized)) {
      await this.stopSession(route.sessionKey);
      await callbacks.reply('Session stopped.');
      return {
        accepted: true,
        reason: 'session_stopped',
        sessionKey: route.sessionKey,
      };
    }

    const replyCallback: RunnerCallbacks = {
      reply: callbacks.reply,
      replace: async () => {},
    };

    const session = await this.getOrCreateSession(route, replyCallback);
    await session.enqueue(message);
    return {
      accepted: true,
      reason: 'enqueued',
      sessionKey: route.sessionKey,
    };
  }

  private isStopCommand(text: string) {
    const lowered = text.toLowerCase();
    return STOP_COMMANDS.has(lowered) || lowered.startsWith('!stop ') || lowered.startsWith('/stop ');
  }

  private isStatusCommand(text: string) {
    const lowered = text.toLowerCase();
    return STATUS_COMMANDS.has(lowered) || lowered.startsWith('!status ') || lowered.startsWith('/status ');
  }

  private async getOrCreateSession(route: ReturnType<typeof routeFromMessage>, callbacks: RunnerCallbacks) {
    const existing = this.sessions.get(route.sessionKey);
    if (existing) {
      return existing;
    }

    const session = new AgentSession(
      route.sessionKey,
      route.sessionKey,
      this.engineFactory(this.config),
      this.store,
      this.config,
      callbacks,
    );
    await session.initialize();
    this.sessions.set(route.sessionKey, session);
    return session;
  }

  private startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      const ttlMs = this.config.SESSION_TTL_SECONDS * 1000;
      const now = Date.now();

      for (const [key, session] of this.sessions.entries()) {
        const last = Date.parse(session.lastActiveAt || '');
        const stale = Number.isFinite(last) && now - last > ttlMs;
        if (stale && session.queueSize === 0) {
          session.stop();
          this.sessions.delete(key);
        }
      }
    }, Math.max(15_000, this.config.SESSION_TTL_SECONDS * 1000 / 2));
  }

  getSessionCount() {
    return this.sessions.size;
  }

  getQueueSize(sessionKey: string) {
    return this.sessions.get(sessionKey)?.queueSize ?? 0;
  }

  async stopSession(sessionKey: string) {
    const session = this.sessions.get(sessionKey);
    if (!session) return false;
    session.stop();
    this.sessions.delete(sessionKey);
    return true;
  }

  listSessions() {
    return Array.from(this.sessions.keys()).map((sessionKey) => ({
      sessionKey,
      queueSize: this.sessions.get(sessionKey)?.queueSize ?? 0,
      lastActiveAt: this.sessions.get(sessionKey)?.lastActiveAt,
    }));
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }
}
