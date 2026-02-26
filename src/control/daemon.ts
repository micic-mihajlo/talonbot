import { AgentSession } from './session';
import { routeFromMessage } from './route';
import { SessionStore } from './store';
import type { RunnerCallbacks, InboundMessage } from '../shared/protocol';
import { buildEngine } from '../engine';
import type { AppConfig } from '../config';
import { isValidAlias, normalizeAlias, type AliasMap, type SessionAlias } from './aliases';

export interface DispatchResult {
  accepted: boolean;
  reason?: string;
  sessionKey?: string;
}

interface RunnerContext {
  reply: (text: string) => Promise<void>;
}

interface ControlCommand {
  name: string;
  args: string[];
}

const STOP_COMMANDS = new Set(['!stop', '/stop', 'stop', '!shutdown', '/shutdown', 'shutdown']);
const STATUS_COMMANDS = new Set(['!status', '/status', 'status']);
const ALIAS_COMMANDS = new Set(['!alias', '/alias', 'alias']);

const HELP_TEXT =
  'Commands: !status [session|alias], !stop [session|alias], !alias set <name> [session|alias], !alias remove <name>, !alias list, !alias resolve <name>';

export class ControlPlane {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly store: SessionStore;
  private aliases: AliasMap = {};
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: AppConfig, private readonly engineFactory = buildEngine) {
    const expandedPath = this.config.DATA_DIR.replace('~', process.env.HOME || '');
    this.store = new SessionStore(expandedPath + '/sessions');
  }

  async initialize() {
    await this.store.init();
    await this.loadAliases();
    this.startCleanupTimer();
  }

  async dispatch(message: InboundMessage, callbacks: RunnerContext): Promise<DispatchResult> {
    const route = routeFromMessage(message);
    const normalized = message.text.trim();

    const command = this.parseCommand(normalized);
    if (command) {
      return this.handleCommand(command, route, callbacks);
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

  private parseCommand(text: string): ControlCommand | null {
    const trimmed = text.trim();
    if (!trimmed || (!trimmed.startsWith('!') && !trimmed.startsWith('/'))) {
      return null;
    }

    const pieces = trimmed.slice(1).trim().split(/\s+/).filter(Boolean);
    if (!pieces.length) return null;

    return {
      name: pieces[0].toLowerCase(),
      args: pieces.slice(1),
    };
  }

  private async handleCommand(command: ControlCommand, route: ReturnType<typeof routeFromMessage>, callbacks: RunnerContext): Promise<DispatchResult> {
    if (STOP_COMMANDS.has(`!${command.name}`)) {
      const target = this.resolveTargetSession(command.args[0], route.sessionKey);
      if (!target) {
        await callbacks.reply('No target session found to stop.');
        return {
          accepted: false,
          reason: 'no_target_session',
          sessionKey: undefined,
        };
      }

      const stopped = await this.stopSession(target);
      if (stopped) {
        await callbacks.reply(`Stopped session ${target}.`);
      } else {
        await callbacks.reply(`Session ${target} not active.`);
      }
      return {
        accepted: true,
        reason: 'session_stopped',
        sessionKey: target,
      };
    }

    if (STATUS_COMMANDS.has(`!${command.name}`)) {
      const target = this.resolveTargetSession(command.args[0], route.sessionKey);
      if (!target) {
        await callbacks.reply('No target session found.');
        return {
          accepted: false,
          reason: 'no_target_session',
          sessionKey: undefined,
        };
      }

      const current = this.sessions.get(target);
      const status = current
        ? `session=${target} active queue=${current.queueSize} last=${current.lastActiveAt}`
        : `session=${target} inactive`;
      await callbacks.reply(status);
      return {
        accepted: true,
        reason: 'status_report',
        sessionKey: target,
      };
    }

    if (ALIAS_COMMANDS.has(`!${command.name}`)) {
      return this.handleAliasCommand(command, route, callbacks);
    }

    if (command.name === 'help' || command.name === 'h') {
      await callbacks.reply(HELP_TEXT);
      return {
        accepted: true,
        reason: 'help',
        sessionKey: route.sessionKey,
      };
    }

    await callbacks.reply(HELP_TEXT);
    return {
      accepted: false,
      reason: 'unknown_command',
      sessionKey: route.sessionKey,
    };
  }

  private async handleAliasCommand(
    command: ControlCommand,
    route: ReturnType<typeof routeFromMessage>,
    callbacks: RunnerContext,
  ): Promise<DispatchResult> {
    const [subcommand, ...args] = command.args;
    if (!subcommand) {
      const entries = Object.keys(this.aliases).sort().map((alias) => `${alias}=${this.aliases[alias].sessionKey}`);
      const message = entries.length ? `Aliases: ${entries.join(', ')}` : 'No aliases configured.';
      await callbacks.reply(message);
      return { accepted: true, reason: 'alias_list', sessionKey: route.sessionKey };
    }

    const normalizedSubcommand = subcommand.toLowerCase();

    if (normalizedSubcommand === 'set' || normalizedSubcommand === 'add') {
      const aliasRaw = args[0];
      const target = this.resolveTargetSession(args[1], route.sessionKey);
      if (!aliasRaw || !target) {
        await callbacks.reply('Usage: !alias set <name> [session|alias]');
        return { accepted: false, reason: 'alias_set_invalid', sessionKey: route.sessionKey };
      }

      const normalizedAlias = normalizeAlias(aliasRaw);
      if (!isValidAlias(normalizedAlias)) {
        await callbacks.reply('Alias must be 1-64 chars: letters, numbers, . _ -');
        return { accepted: false, reason: 'alias_invalid', sessionKey: route.sessionKey };
      }

      await this.setAlias(normalizedAlias, target);
      await callbacks.reply(`Alias "${normalizedAlias}" now points to ${target}.`);
      return {
        accepted: true,
        reason: 'alias_set',
        sessionKey: target,
      };
    }

    if (normalizedSubcommand === 'remove' || normalizedSubcommand === 'rm' || normalizedSubcommand === 'delete') {
      const aliasRaw = args[0];
      if (!aliasRaw) {
        await callbacks.reply('Usage: !alias remove <name>');
        return { accepted: false, reason: 'alias_remove_invalid', sessionKey: route.sessionKey };
      }
      const normalizedAlias = normalizeAlias(aliasRaw);
      const previous = await this.removeAlias(normalizedAlias);
      if (!previous) {
        await callbacks.reply(`Alias "${normalizedAlias}" not found.`);
        return { accepted: false, reason: 'alias_not_found', sessionKey: route.sessionKey };
      }
      await callbacks.reply(`Alias "${normalizedAlias}" removed.`);
      return { accepted: true, reason: 'alias_remove', sessionKey: previous.sessionKey };
    }

    if (normalizedSubcommand === 'list' || normalizedSubcommand === 'ls') {
      const search = args[0] ? normalizeAlias(args[0]) : undefined;
      const entries = Object.entries(this.aliases)
        .filter(([alias]) => !search || alias.startsWith(search))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([alias, value]) => `${alias}=${value.sessionKey}`);
      const message = entries.length ? `Aliases: ${entries.join(', ')}` : 'No aliases configured.';
      await callbacks.reply(message);
      return { accepted: true, reason: 'alias_list', sessionKey: route.sessionKey };
    }

    if (normalizedSubcommand === 'resolve') {
      const aliasRaw = args[0];
      if (!aliasRaw) {
        await callbacks.reply('Usage: !alias resolve <name>');
        return { accepted: false, reason: 'alias_resolve_invalid', sessionKey: route.sessionKey };
      }

      const normalizedAlias = normalizeAlias(aliasRaw);
      const resolved = this.resolveAlias(normalizedAlias);
      if (!resolved) {
        await callbacks.reply(`Alias "${normalizedAlias}" not found.`);
        return { accepted: false, reason: 'alias_not_found', sessionKey: route.sessionKey };
      }
      await callbacks.reply(`${normalizedAlias} => ${resolved.sessionKey}`);
      return { accepted: true, reason: 'alias_resolve', sessionKey: resolved.sessionKey };
    }

    await callbacks.reply(`Unknown alias command "${normalizedSubcommand}". ${HELP_TEXT}`);
    return { accepted: false, reason: 'alias_unknown', sessionKey: route.sessionKey };
  }

  private resolveTargetSession(reference: string | undefined, fallback: string) {
    const target = (reference || '').trim();
    if (!target) {
      return fallback;
    }

    const alias = this.resolveAlias(target);
    return alias ? alias.sessionKey : target;
  }

  private async loadAliases() {
    this.aliases = await this.store.readAliasMap();
  }

  private async persistAliases() {
    await this.store.writeAliasMap(this.aliases);
  }

  resolveAlias(alias: string): SessionAlias | null {
    const normalized = normalizeAlias(alias);
    return this.aliases[normalized] ?? null;
  }

  async setAlias(alias: string, sessionKey: string) {
    const normalizedAlias = normalizeAlias(alias);
    if (!isValidAlias(normalizedAlias)) {
      throw new Error('invalid_alias');
    }
    this.aliases[normalizedAlias] = {
      alias: normalizedAlias,
      sessionKey,
      createdAt: new Date().toISOString(),
    };
    await this.persistAliases();
  }

  async removeAlias(alias: string) {
    const normalizedAlias = normalizeAlias(alias);
    const existing = this.aliases[normalizedAlias];
    if (!existing) {
      return null;
    }
    delete this.aliases[normalizedAlias];
    await this.persistAliases();
    return existing;
  }

  listAliases() {
    return Object.values(this.aliases)
      .map((entry) => ({
        alias: entry.alias,
        sessionKey: entry.sessionKey,
        createdAt: entry.createdAt,
      }))
      .sort((a, b) => a.alias.localeCompare(b.alias));
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
