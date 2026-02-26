import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { AgentSession } from './session.js';
import { routeFromMessage } from './route.js';
import { SessionStore } from './store.js';
import type {
  ControlRpcCommand,
  ControlRpcParsedCommand,
  ControlRpcClearCommand,
  ControlRpcEvent,
  ControlRpcResponse,
  ControlRpcSendCommand,
  ControlRpcSubscribeCommand,
  LegacyControlCommand,
  RunnerCallbacks,
  InboundMessage,
} from '../shared/protocol.js';
import { buildEngine } from '../engine/index.js';
import type { AppConfig } from '../config.js';
import { isValidAlias, normalizeAlias, type AliasMap, type SessionAlias } from './aliases.js';

export interface DispatchResult {
  accepted: boolean;
  reason?: string;
  sessionKey?: string;
}

interface SessionMetadata {
  sessionKey: string;
  queueSize: number;
  lastActiveAt?: string;
  isIdle: boolean;
  aliases: string[];
  socketPath?: string;
}

interface RunnerContext {
  reply: (text: string) => Promise<void>;
}

interface ControlCommand {
  name: string;
  args: string[];
}

interface TurnEndSubscription {
  socket: net.Socket;
  subscriptionId: string;
}

interface SessionSocketState {
  server: net.Server;
  socketPath: string;
}

interface SessionLookup {
  session: AgentSession;
}

const STOP_COMMANDS = new Set(['!stop', '/stop', 'stop', '!shutdown', '/shutdown', 'shutdown']);
const STATUS_COMMANDS = new Set(['!status', '/status', 'status']);
const ALIAS_COMMANDS = new Set(['!alias', '/alias', 'alias']);

const HELP_TEXT =
  'Commands: !status [session|alias], !stop [session|alias], !alias set <name> [session|alias], !alias remove <name>, !alias list, !alias resolve <name>';

const CONTROL_SUFFIX = '.sock';
const ALIAS_SUFFIX = '.alias';
const isErr = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === 'object' && error !== null && 'code' in error;

const randomId = (prefix = 'talon') => `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

const writeResponse = (socket: net.Socket, response: ControlRpcResponse | ControlRpcEvent) => {
  try {
    socket.write(`${JSON.stringify(response)}\n`);
  } catch {
    // ignore if socket closed mid-write
  }
};

export class ControlPlane {
  private readonly sessions = new Map<string, SessionLookup>();
  private readonly sessionSockets = new Map<string, SessionSocketState>();
  private readonly turnEndSubscriptions = new Map<string, Set<TurnEndSubscription>>();
  private readonly store: SessionStore;
  private readonly controlSessionDir: string;
  private aliases: AliasMap = {};
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly config: AppConfig, private readonly engineFactory = buildEngine) {
    const expandedDataPath = config.DATA_DIR.replace('~', process.env.HOME || '');
    const expandedControlPath = config.CONTROL_SOCKET_PATH.replace('~', process.env.HOME || '');
    const controlDir = path.dirname(expandedControlPath);
    this.store = new SessionStore(path.join(expandedDataPath, 'sessions'));
    this.controlSessionDir = path.join(controlDir, 'session-control');
  }

  async initialize() {
    await this.store.init();
    await this.loadAliases();
    await this.ensureControlDirectory();
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

    const session = await this.getOrCreateSession(route.sessionKey, replyCallback);
    await session.session.enqueue(message);
    return {
      accepted: true,
      reason: 'enqueued',
      sessionKey: route.sessionKey,
    };
  }

  parseControlRpc(command: unknown): ControlRpcParsedCommand | null {
    if (!command || typeof command !== 'object') return null;
    const raw = command as {
      type?: unknown;
      id?: unknown;
      sessionKey?: unknown;
      message?: unknown;
      mode?: unknown;
      summarize?: unknown;
      event?: unknown;
    };
    const commandType = typeof raw.type === 'string' ? raw.type : undefined;
    if (!commandType) return null;

    if (commandType === 'send') {
      return raw as ControlRpcCommand;
    }

    if (commandType === 'clear') {
      return raw as ControlRpcClearCommand;
    }

    if (commandType === 'subscribe') {
      return raw as ControlRpcSubscribeCommand;
    }

    if (!['get_message', 'get_summary', 'abort'].includes(commandType)) {
      return {
        type: commandType,
        ...raw,
      } as ControlRpcParsedCommand;
    }

    return {
      ...(raw as { id?: string; sessionKey?: string }),
      type: commandType,
    } as ControlRpcCommand;
  }

  parseLegacyCommand(command: unknown): LegacyControlCommand | null {
    if (!command || typeof command !== 'object') return null;
    const raw = command as { action?: unknown };
    if (typeof raw.action !== 'string') return null;
    return raw as LegacyControlCommand;
  }

  async handleLegacySocketCommand(command: LegacyControlCommand) {
    const response = { accepted: true } as { accepted: boolean; error?: string; data?: unknown; command?: string };

    if (command.action === 'health') {
      return {
        healthy: true,
        sessions: this.listSessions(),
      };
    }

    if (command.action === 'alias_list') {
      return {
        aliases: this.listAliases(),
      };
    }

    if (command.action === 'alias_resolve') {
      const alias = command.alias;
      if (!alias) {
        response.accepted = false;
        response.error = 'alias required';
        return response;
      }
      const resolved = this.resolveAlias(alias);
      if (!resolved) {
        response.accepted = false;
        response.error = 'alias_not_found';
        return response;
      }
      return {
        alias: resolved.alias,
        sessionKey: resolved.sessionKey,
      };
    }

    if (command.action === 'alias_set') {
      if (!command.alias || !command.sessionKey) {
        response.accepted = false;
        response.error = 'alias and sessionKey required';
        return response;
      }
      await this.setAlias(command.alias, command.sessionKey);
      return {
        alias: command.alias,
        sessionKey: command.sessionKey,
      };
    }

    if (command.action === 'alias_unset') {
      if (!command.alias) {
        response.accepted = false;
        response.error = 'alias required';
        return response;
      }
      const removed = await this.removeAlias(command.alias);
      if (!removed) {
        response.accepted = false;
        response.error = 'alias_not_found';
        return response;
      }
      return {
        alias: command.alias,
        removed: true,
      };
    }

    if (command.action === 'list') {
      return {
        sessions: this.listSessions(),
      };
    }

    if (command.action === 'stop') {
      if (!command.sessionKey) {
        response.accepted = false;
        response.error = 'sessionKey required';
        return response;
      }
      const stopped = await this.stopSession(command.sessionKey);
      return { stopped };
    }

    if (command.action === 'send') {
      if (!command.source || !command.channelId || !command.text) {
        response.accepted = false;
        response.error = 'source, channelId and text required';
        return response;
      }

      const source = command.source;
      const message: InboundMessage = {
        id: randomId('socket'),
        source,
        sourceChannelId: command.channelId,
        sourceThreadId: command.threadId,
        sourceMessageId: randomId('msg'),
        senderId: command.senderId || 'socket',
        senderName: 'socket',
        senderIsBot: false,
        text: command.text,
        mentionsBot: true,
        attachments: [],
        metadata: command.metadata || {},
        receivedAt: new Date().toISOString(),
      };

      const route = routeFromMessage(message);
      const session = await this.getOrCreateSession(route.sessionKey, {
        reply: async () => {},
        replace: async () => {},
      });
      await session.session.enqueue(message);
      return {
        accepted: true,
        sessionKey: route.sessionKey,
      };
    }

    if (command.action === 'get_message') {
      const target = command.sessionKey;
      if (!target) {
        response.accepted = false;
        response.error = 'sessionKey required';
        return response;
      }
      const session = this.sessions.get(target);
      if (!session) {
        response.accepted = false;
        response.error = 'session_not_found';
        return response;
      }
      const message = session.session.getLastAssistantMessage();
      return {
        message,
      };
    }

    if (command.action === 'get_summary') {
      const target = command.sessionKey;
      if (!target) {
        response.accepted = false;
        response.error = 'sessionKey required';
        return response;
      }
      const session = this.sessions.get(target);
      if (!session) {
        response.accepted = false;
        response.error = 'session_not_found';
        return response;
      }
      try {
        const summary = await session.session.getSummary();
        return {
          summary,
          model: 'agent',
        };
      } catch (error) {
        response.accepted = false;
        response.error = error instanceof Error ? error.message : 'Summary failed';
        return response;
      }
    }

    if (command.action === 'clear') {
      const target = command.sessionKey;
      if (!target) {
        response.accepted = false;
        response.error = 'sessionKey required';
        return response;
      }
      const session = this.sessions.get(target);
      if (!session) {
        response.accepted = false;
        response.error = 'session_not_found';
        return response;
      }
      try {
        const clearResult = await session.session.clear(Boolean(command.summarize));
        return clearResult;
      } catch (error) {
        response.accepted = false;
        response.error = error instanceof Error ? error.message : 'Clear failed';
        return response;
      }
    }

    if (command.action === 'abort') {
      const target = command.sessionKey;
      if (!target) {
        response.accepted = false;
        response.error = 'sessionKey required';
        return response;
      }
      const session = this.sessions.get(target);
      if (!session) {
        response.accepted = false;
        response.error = 'session_not_found';
        return response;
      }
      const aborted = await session.session.abort();
      return {
        aborted,
      };
    }

    response.accepted = false;
    response.error = `Unsupported action: ${command.action}`;
    return response;
  }

  async handleSessionRpcCommand(
    sessionKey: string,
    command: ControlRpcParsedCommand,
    socket?: net.Socket,
  ): Promise<ControlRpcResponse> {
    const id = 'id' in command && typeof command.id === 'string' ? command.id : undefined;
    const result = (success: boolean, commandName: string, data?: unknown, error?: string): ControlRpcResponse => ({
      type: 'response',
      command: commandName,
      success,
      data,
      error,
      id,
    });

    if (!sessionKey) {
      return result(false, command.type, undefined, 'sessionKey required');
    }

    const session = await this.getOrCreateSession(sessionKey, {
      reply: async () => {},
      replace: async () => {},
    });

    if (command.type === 'subscribe') {
      if (command.event !== 'turn_end') {
        return result(false, 'subscribe', undefined, `Unknown event type: ${command.event}`);
      }

      const subscriptionId = command.id ?? `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let subs = this.turnEndSubscriptions.get(sessionKey);
      if (!subs) {
        subs = new Set<TurnEndSubscription>();
        this.turnEndSubscriptions.set(sessionKey, subs);
      }

      const sub = { socket, subscriptionId };
      if (socket) {
        subs.add(sub);
        const cleanup = () => {
          const current = this.turnEndSubscriptions.get(sessionKey);
          current?.delete(sub);
          if (!current || current.size === 0) {
            this.turnEndSubscriptions.delete(sessionKey);
          }
        };
        socket.once('close', cleanup);
        socket.once('error', cleanup);
      }
      return result(true, 'subscribe', { subscriptionId, event: 'turn_end' });
    }

    if (command.type === 'send') {
      const messageText = command.message;
      if (typeof messageText !== 'string' || !messageText.trim().length) {
        return result(false, 'send', undefined, 'Missing message');
      }

      const inbound: InboundMessage = {
        id: randomId('session-send'),
        source: 'socket',
        sourceChannelId: sessionKey,
        sourceMessageId: randomId('msg'),
        senderId: 'operator',
        senderName: 'operator',
        senderIsBot: false,
        text: messageText,
        mentionsBot: true,
        attachments: [],
        metadata: {
          via: 'session-rpc',
        },
        receivedAt: new Date().toISOString(),
      };
      await session.session.enqueue(inbound);
      const mode = session.session.isIdle ? 'direct' : command.mode || 'steer';
      return result(true, 'send', {
        delivered: true,
        mode,
      });
    }

    if (command.type === 'get_message') {
      const message = session.session.getLastAssistantMessage();
      return result(true, 'get_message', { message });
    }

    if (command.type === 'get_summary') {
      try {
        const summary = await session.session.getSummary();
        return result(true, 'get_summary', {
          summary,
          model: 'agent',
        });
      } catch (error) {
        return result(false, 'get_summary', undefined, error instanceof Error ? error.message : 'Summary failed');
      }
    }

    if (command.type === 'clear') {
      try {
        const clearResult = await session.session.clear(Boolean(command.summarize));
        return result(true, 'clear', clearResult);
      } catch (error) {
        return result(false, 'clear', undefined, error instanceof Error ? error.message : 'Clear failed');
      }
    }

    if (command.type === 'abort') {
      const aborted = await session.session.abort();
      return result(true, 'abort', { aborted });
    }

    return result(false, command.type, undefined, `Unsupported command: ${command.type}`);
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

      const session = this.sessions.get(target);
      const status = session
        ? `session=${target} active queue=${session.session.queueSize} last=${session.session.lastActiveAt}`
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

  private resolveTargetSession(reference: string | undefined, fallback: string) {
    const target = (reference || '').trim();
    if (!target) {
      return fallback;
    }

    const alias = this.resolveAlias(target);
    return alias ? alias.sessionKey : target;
  }

  private async ensureControlDirectory() {
    if (!fs.existsSync(this.controlSessionDir)) {
      await fs.promises.mkdir(this.controlSessionDir, { recursive: true });
    }
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
    const socketState = this.sessionSockets.get(sessionKey);
    if (socketState) {
      await this.createAliasSymlink(normalizedAlias, socketState.socketPath);
    }
  }

  async removeAlias(alias: string) {
    const normalizedAlias = normalizeAlias(alias);
    const existing = this.aliases[normalizedAlias];
    if (!existing) {
      return null;
    }
    delete this.aliases[normalizedAlias];
    await this.persistAliases();
    await this.removeAliasSymlink(normalizedAlias);
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

  private aliasesForSession(sessionKey: string) {
    return Object.values(this.aliases)
      .filter((entry) => entry.sessionKey === sessionKey)
      .map((entry) => entry.alias)
      .sort((a, b) => a.localeCompare(b));
  }

  private async getOrCreateSession(sessionKey: string, callbacks: RunnerCallbacks) {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    const session = new AgentSession(
      sessionKey,
      sessionKey,
      this.engineFactory(this.config),
      this.store,
      this.config,
      callbacks,
      {
        onTurnEnd: (event) => {
          this.emitTurnEnd(sessionKey, event);
        },
      },
    );

    await session.initialize();

    const state: SessionLookup = {
      session,
    };
    this.sessions.set(sessionKey, state);
    await this.ensureSessionSocket(sessionKey);

    await this.syncAliasSymlinks(sessionKey);
    return state;
  }

  async ensureSessionSocket(sessionKey: string) {
    if (this.sessionSockets.has(sessionKey)) {
      return;
    }

    const sessionId = this.sessionId(sessionKey);
    const socketPath = path.join(this.controlSessionDir, `${sessionId}${CONTROL_SUFFIX}`);

    try {
      if (fs.existsSync(socketPath)) {
        fs.rmSync(socketPath);
      }

      const server = net.createServer((socket) => {
        socket.setEncoding('utf8');
        let buffer = '';

        socket.on('data', async (chunk) => {
          buffer += chunk as string;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }
            try {
              const payload = JSON.parse(line.trim());
              const command = this.parseControlRpc(payload);
              if (command && command.type) {
                const response = await this.handleSessionRpcCommand(sessionKey, command, socket);
                writeResponse(socket, response);
                if (command.type === 'subscribe' && command.event === 'turn_end') {
                  continue;
                }
                continue;
              }

              if (payload && typeof payload === 'object' && 'type' in payload) {
                const parsedType = (payload as { type?: unknown }).type;
                if (typeof parsedType !== 'string') {
                  writeResponse(socket, {
                    type: 'response',
                    command: 'parse',
                    success: false,
                    error: 'Failed to parse command: Missing command type',
                  });
                  continue;
                }
              }

              if (payload && typeof payload === 'object' && !('type' in payload)) {
                writeResponse(socket, {
                  type: 'response',
                  command: 'parse',
                  success: false,
                  error: 'Failed to parse command: Missing command type',
                });
                continue;
              }

              writeResponse(socket, {
                type: 'response',
                command: 'parse',
                success: false,
                error: 'Failed to parse command',
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Failed to parse command';
              writeResponse(socket, {
                type: 'response',
                command: 'parse',
                success: false,
                error: message,
              });
            }
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.listen(socketPath, () => {
          resolve();
        });
        server.once('error', (error) => {
          reject(error);
        });
      });

      this.sessionSockets.set(sessionKey, { server, socketPath });
      await this.syncAliasSymlinks(sessionKey);
    } catch (error) {
      if (isErr(error) && error.code === 'EADDRINUSE') {
        const exists = fs.existsSync(socketPath);
        if (exists) {
          fs.rmSync(socketPath);
          await this.ensureSessionSocket(sessionKey);
          return;
        }
      }
      throw error;
    }
  }

  private async closeSessionSocket(sessionKey: string) {
    const state = this.sessionSockets.get(sessionKey);
    if (!state) {
      return;
    }
    await this.removeAliasesForSocket(state.socketPath);

    const toClose = new Promise<void>((resolve) => {
      state.server.close(() => {
        resolve();
      });
    });

    await toClose;

    if (fs.existsSync(state.socketPath)) {
      fs.rmSync(state.socketPath);
    }

    this.sessionSockets.delete(sessionKey);
    this.turnEndSubscriptions.delete(sessionKey);
  }

  private async syncAliasSymlinks(sessionKey: string) {
    const state = this.sessionSockets.get(sessionKey);
    if (!state) {
      return;
    }
    await this.removeAliasesForSocket(state.socketPath);

    const aliases = this.aliasesForSession(sessionKey);
    for (const alias of aliases) {
      await this.createAliasSymlink(alias, state.socketPath);
    }
  }

  private async createAliasSymlink(alias: string, socketPath: string) {
    const aliasName = normalizeAlias(alias);
    if (!isValidAlias(aliasName)) {
      return;
    }

    const aliasPath = path.join(this.controlSessionDir, `${aliasName}${ALIAS_SUFFIX}`);
    const target = `${path.basename(socketPath)}`;

    try {
      if (fs.existsSync(aliasPath)) {
        fs.rmSync(aliasPath);
      }
      await fs.promises.symlink(target, aliasPath);
    } catch (error) {
      if (isErr(error) && error.code === 'EEXIST') {
        return;
      }
      throw error;
    }
  }

  private async removeAliasSymlink(alias: string) {
    const pathValue = path.join(this.controlSessionDir, `${normalizeAlias(alias)}${ALIAS_SUFFIX}`);
    if (!fs.existsSync(pathValue)) {
      return;
    }

    try {
      await fs.promises.unlink(pathValue);
    } catch {
      // ignore
    }
  }

  private async removeAliasesForSocket(socketPath: string) {
    const entries = await fs.promises.readdir(this.controlSessionDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isSymbolicLink()) {
        continue;
      }

      if (!entry.name.endsWith(ALIAS_SUFFIX)) {
        continue;
      }

      const aliasPath = path.join(this.controlSessionDir, entry.name);
      let target: string;
      try {
        target = await fs.promises.readlink(aliasPath);
      } catch {
        continue;
      }

      const resolved = path.resolve(this.controlSessionDir, target);
      if (resolved === socketPath) {
        await fs.promises.unlink(aliasPath).catch(() => undefined);
      }
    }

  }

  private sessionId(sessionKey: string) {
    return crypto.createHash('sha1').update(sessionKey).digest('hex');
  }

  private emitTurnEnd(sessionKey: string, event: { message: unknown; turnIndex: number }) {
    const subs = this.turnEndSubscriptions.get(sessionKey);
    if (!subs || subs.size === 0) {
      return;
    }

    for (const sub of Array.from(subs)) {
      writeResponse(sub.socket, {
        type: 'event',
        event: 'turn_end',
        data: event,
        subscriptionId: sub.subscriptionId,
      });
      subs.delete(sub);
    }

    if (subs.size === 0) {
      this.turnEndSubscriptions.delete(sessionKey);
    }
  }

  private startCleanupTimer() {
    this.cleanupTimer = setInterval(() => {
      const ttlMs = this.config.SESSION_TTL_SECONDS * 1000;
      const now = Date.now();

      for (const [key, lookup] of this.sessions.entries()) {
        const last = Date.parse(lookup.session.lastActiveAt || '');
        const stale = Number.isFinite(last) && now - last > ttlMs;
        if (stale && lookup.session.queueSize === 0) {
          lookup.session.stop();
          this.stopSession(key).catch(() => undefined);
        }
      }
    }, Math.max(15_000, this.config.SESSION_TTL_SECONDS * 1000 / 2));
  }

  getSessionCount() {
    return this.sessions.size;
  }

  getQueueSize(sessionKey: string) {
    return this.sessions.get(sessionKey)?.session.queueSize ?? 0;
  }

  async stopSession(sessionKey: string) {
    const lookup = this.sessions.get(sessionKey);
    if (!lookup) {
      await this.closeSessionSocket(sessionKey);
      return false;
    }

    lookup.session.stop();
    this.sessions.delete(sessionKey);
    await this.closeSessionSocket(sessionKey);
    return true;
  }

  listSessions() {
    return Array.from(this.sessions.entries()).map(([sessionKey, lookup]) => ({
      sessionKey,
      queueSize: lookup.session.queueSize,
      lastActiveAt: lookup.session.lastActiveAt,
      isIdle: lookup.session.isIdle,
      aliases: this.aliasesForSession(sessionKey),
      socketPath: this.sessionSockets.get(sessionKey)?.socketPath,
    } as SessionMetadata));
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    for (const sessionKey of Array.from(this.sessions.keys())) {
      this.stopSession(sessionKey).catch(() => undefined);
    }
  }
}
