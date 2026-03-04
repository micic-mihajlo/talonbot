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
import { createLogger } from '../utils/logger.js';
import type { TaskOrchestrator } from '../orchestration/task-orchestrator.js';
import { TaskUpdateNotifier, type OutboundThreadMessage, type OutboundThreadSender } from './task-update-notifier.js';
import type { TaskThreadBinding } from './store.js';
import type { TaskIntent, RequiredArtifactKind } from '../orchestration/types.js';

export interface DispatchResult {
  accepted: boolean;
  reason?: string;
  sessionKey?: string;
  mode?: 'task' | 'session';
  taskId?: string;
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

interface ControlPlaneOptions {
  tasks?: TaskOrchestrator;
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
    tokens: ['ops', 'restart', 'reboot', 'service', 'deploy', 'incident', 'rollback', 'scale', 'alert', 'observability', 'health'],
  },
];

const EXPLICIT_TASK_CUE_TOKENS = new Set([
  'task',
  'implement',
  'implementation',
  'fix',
  'patch',
  'add',
  'create',
  'update',
  'change',
  'refactor',
  'commit',
  'branch',
  'push',
  'worktree',
  'deploy',
  'rollback',
]);

const EXPLICIT_TASK_CUE_PHRASES: ReadonlyArray<RegExp> = [
  /\b(?:open|create|make|submit|raise)\s+(?:a\s+)?(?:pr|pull request)\b/i,
  /\b(?:create|make)\s+(?:a\s+)?branch\b/i,
  /\b(?:commit|push)\b/i,
];

interface TaskPolicyHintInput {
  taskIntent?: TaskIntent;
  requiresVerifiedPr?: boolean;
  requirePrOverride?: boolean;
  requiredArtifacts?: Array<'summary' | 'branch' | 'commit' | 'pr'>;
}

interface TaskPolicy {
  taskIntent: TaskIntent;
  requiresVerifiedPr: boolean;
  requiredArtifacts: RequiredArtifactKind[];
}

const HEAVY_TASK_TIMEOUT_MS = 5 * 60 * 1000;
const REPO_CREATION_CUES = [
  /\bcreate\b.*\bnew\b.*\b(?:github\s+)?repo(?:sitory)?\b/i,
  /\b(?:create|make|spin up|bootstrap|scaffold)\b.*\b(?:github\s+)?repo(?:sitory)?\b/i,
];

const inferTargetRepoFullName = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const fromUrl = trimmed.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i);
  if (fromUrl) {
    return `${fromUrl[1]}/${fromUrl[2].replace(/\.git$/i, '')}`;
  }

  const ownerMatch = trimmed.match(/\bunder\s+([A-Za-z0-9_.-]+)/i);
  const repoMatch =
    trimmed.match(/\b(?:repo(?:sitory)?\s+named|named)\s+([A-Za-z0-9_.-]+)/i) ||
    trimmed.match(/\b(?:repo|repository)\s+([A-Za-z0-9_.-]+)/i);
  if (ownerMatch && repoMatch) {
    return `${ownerMatch[1]}/${repoMatch[1].replace(/\.git$/i, '')}`;
  }

  return undefined;
};

const inferTaskTimeoutMs = (text: string, baseTimeoutMs: number, targetRepoFullName?: string): number | undefined => {
  const boundedBase = Number.isFinite(baseTimeoutMs) ? Math.max(1000, Math.floor(baseTimeoutMs)) : 120000;
  const looksHeavy = targetRepoFullName && REPO_CREATION_CUES.some((pattern) => pattern.test(text));
  if (!looksHeavy) {
    return undefined;
  }
  return Math.max(boundedBase, HEAVY_TASK_TIMEOUT_MS);
};

const normalizeTaskArtifactKinds = (artifacts?: ReadonlyArray<string> | string | undefined): RequiredArtifactKind[] | undefined => {
  if (typeof artifacts === 'string') {
    artifacts = artifacts.split(',').map((value) => value.trim());
  }

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

const parseBooleanMetadata = (value: string | boolean | undefined): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'undefined') return value;

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
};

const isValidTaskIntent = (value: string): value is TaskIntent =>
  value === 'research' || value === 'review' || value === 'summarize' || value === 'implementation' || value === 'ops' || value === 'unknown';

const uniqueArtifacts = (artifacts: ReadonlyArray<RequiredArtifactKind>) => [...new Set(artifacts)].sort();

const defaultArtifactsForPolicy = (requiresVerifiedPr: boolean): RequiredArtifactKind[] =>
  requiresVerifiedPr ? uniqueArtifacts(['pr']) : uniqueArtifacts(['summary']);

const parseTaskIntent = (value: string | undefined): TaskIntent | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return isValidTaskIntent(normalized) ? normalized : undefined;
};

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

const hasExplicitTaskCue = (text: string): boolean => {
  const tokens = text.toLowerCase().match(/[a-z0-9_-]+/g) || [];
  if (tokens.some((token) => EXPLICIT_TASK_CUE_TOKENS.has(token))) {
    return true;
  }
  return EXPLICIT_TASK_CUE_PHRASES.some((pattern) => pattern.test(text));
};

const normalizePolicyMetadata = (metadata: Record<string, string> | undefined): TaskPolicyHintInput => {
  if (!metadata) {
    return {};
  }

  return {
    taskIntent: parseTaskIntent(metadata.taskIntent || metadata.task_intent),
    requiresVerifiedPr: parseBooleanMetadata(metadata.requiresVerifiedPr || metadata.requires_verified_pr),
    requirePrOverride: parseBooleanMetadata(metadata.requirePrOverride || metadata.require_pr_override),
    requiredArtifacts: normalizeTaskArtifactKinds(metadata.requiredArtifacts || metadata.required_artifacts),
  };
};

const coerceTaskPolicyHint = (hint: TaskPolicyHintInput | undefined): TaskPolicyHintInput => {
  if (!hint) return {};
  const result: TaskPolicyHintInput = {};
  if (hint.taskIntent) {
    result.taskIntent = hint.taskIntent;
  }
  if (typeof hint.requiresVerifiedPr === 'boolean') {
    result.requiresVerifiedPr = hint.requiresVerifiedPr;
  }
  if (typeof hint.requirePrOverride === 'boolean') {
    result.requirePrOverride = hint.requirePrOverride;
  }
  const normalizedArtifacts = normalizeTaskArtifactKinds(hint.requiredArtifacts);
  if (normalizedArtifacts) {
    result.requiredArtifacts = normalizedArtifacts;
  }
  return result;
};

const resolveTaskPolicy = (input: {
  text: string;
  messageMetadata: Record<string, string>;
  taskPolicyHint?: TaskPolicyHintInput;
  defaultVerifiedPr: boolean;
}): TaskPolicy => {
  const metadataHint = normalizePolicyMetadata(input.messageMetadata);
  const policyHint = {
    ...coerceTaskPolicyHint(metadataHint),
    ...coerceTaskPolicyHint(input.taskPolicyHint),
  };

  const taskIntent = policyHint.taskIntent ?? inferTaskIntent(input.text);
  const requiresVerifiedPr =
    typeof policyHint.requirePrOverride === 'boolean'
      ? policyHint.requirePrOverride
      : typeof policyHint.requiresVerifiedPr === 'boolean'
        ? policyHint.requiresVerifiedPr
        : taskIntent === 'implementation'
          ? input.defaultVerifiedPr
          : false;

  let requiredArtifacts = normalizeTaskArtifactKinds(policyHint.requiredArtifacts) || defaultArtifactsForPolicy(requiresVerifiedPr);
  if (requiresVerifiedPr && !requiredArtifacts.includes('pr')) {
    requiredArtifacts = uniqueArtifacts([...requiredArtifacts, 'pr']);
  }

  return {
    taskIntent,
    requiresVerifiedPr,
    requiredArtifacts,
  };
};

export class ControlPlane {
  private readonly logger: ReturnType<typeof createLogger>;
  private readonly sessions = new Map<string, SessionLookup>();
  private readonly sessionSockets = new Map<string, SessionSocketState>();
  private readonly turnEndSubscriptions = new Map<string, Set<TurnEndSubscription>>();
  private readonly seenEventIds = new Map<string, number>();
  private readonly outboundSenders = new Map<'slack' | 'discord' | 'socket', OutboundThreadSender>();
  private readonly store: SessionStore;
  private readonly controlSessionDir: string;
  private readonly tasks?: TaskOrchestrator;
  private readonly taskNotifier?: TaskUpdateNotifier;
  private aliases: AliasMap = {};
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: AppConfig,
    private readonly engineFactory = buildEngine,
    options: ControlPlaneOptions = {},
  ) {
    this.logger = createLogger('control.daemon', config.LOG_LEVEL as any);
    const expandedDataPath = config.DATA_DIR.replace('~', process.env.HOME || '');
    const expandedControlPath = config.CONTROL_SOCKET_PATH.replace('~', process.env.HOME || '');
    const controlDir = path.dirname(expandedControlPath);
    this.store = new SessionStore(path.join(expandedDataPath, 'sessions'));
    this.controlSessionDir = path.join(controlDir, 'session-control');
    this.tasks = options.tasks;
    if (this.tasks) {
      this.taskNotifier = new TaskUpdateNotifier(
        this.store,
        this.tasks,
        (source) => this.outboundSenders.get(source),
        this.config.CHAT_TASK_UPDATE_POLL_MS,
        this.logger,
      );
    }
  }

  async initialize() {
    await this.store.init();
    await this.loadAliases();
    await this.ensureControlDirectory();
    if (this.taskNotifier) {
      await this.taskNotifier.initialize();
    }
    this.startCleanupTimer();
  }

  async dispatch(
    message: InboundMessage,
    callbacks: RunnerContext,
    taskPolicyHint?: TaskPolicyHintInput,
  ): Promise<DispatchResult> {
    const route = routeFromMessage(message);
    const normalized = message.text.trim();

    if (this.hasSeenEvent(message.id)) {
      return {
        accepted: true,
        reason: 'duplicate',
        sessionKey: route.sessionKey,
      };
    }
    this.touchSeen(message.id);

    const directive = this.parseDispatchDirective(normalized);
    if (!directive.text.length) {
      await callbacks.reply('Message text is required.');
      return {
        accepted: false,
        reason: 'empty_message',
        sessionKey: route.sessionKey,
      };
    }
    const routedMessage = directive.text === normalized ? message : { ...message, text: directive.text };

    const command = this.parseCommand(routedMessage.text);
    if (command) {
      return this.handleCommand(command, route, callbacks);
    }

    if (this.shouldDispatchTaskFlow(directive.modeOverride, routedMessage, taskPolicyHint)) {
      return this.dispatchToTask(route.sessionKey, routedMessage, callbacks, taskPolicyHint);
    }

    return this.dispatchToSession(route.sessionKey, routedMessage, callbacks);
  }

  async dispatchToSession(sessionKey: string, message: InboundMessage, callbacks: RunnerContext): Promise<DispatchResult> {
    const normalizedSessionKey = this.resolveSessionReference(sessionKey);
    if (!normalizedSessionKey) {
      return {
        accepted: false,
        reason: 'sessionKey required',
      };
    }

    const session = await this.getOrCreateSession(normalizedSessionKey, this.buildRunnerCallbacks(callbacks));
    await session.session.enqueue(message);
    this.logger.debug('message enqueued', {
      sessionKey: normalizedSessionKey,
      source: message.source,
      channelId: message.sourceChannelId,
      threadId: message.sourceThreadId ?? 'main',
      eventId: message.id,
    });
    return {
      accepted: true,
      reason: 'enqueued',
      sessionKey: normalizedSessionKey,
      mode: 'session',
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
      const target = this.resolveSessionReference(command.sessionKey);
      if (!target) {
        response.accepted = false;
        response.error = 'sessionKey required';
        return response;
      }
      const stopped = await this.stopSession(target);
      return { stopped };
    }

    if (command.action === 'send') {
      const messageText = command.text?.trim();
      if (!messageText) {
        response.accepted = false;
        response.error = 'text required';
        return response;
      }

      const targetSessionKey = this.resolveSessionReference(command.sessionKey || command.alias);
      if (targetSessionKey) {
        const sendResponse = await this.handleSessionRpcCommand(targetSessionKey, {
          type: 'send',
          id: randomId('legacy-send'),
          sessionKey: targetSessionKey,
          message: messageText,
          mode: command.mode,
        });
        if (!sendResponse.success) {
          response.accepted = false;
          response.error = sendResponse.error || 'session_dispatch_failed';
          return response;
        }

        return {
          accepted: true,
          sessionKey: targetSessionKey,
        };
      }

      if (!command.source || !command.channelId) {
        response.accepted = false;
        response.error = 'source and channelId required when sessionKey or alias are not provided';
        return response;
      }

      const message: InboundMessage = {
        id: randomId('socket'),
        source: command.source,
        sourceChannelId: command.channelId,
        sourceThreadId: command.threadId,
        sourceMessageId: randomId('msg'),
        senderId: command.senderId || 'socket',
        senderName: 'socket',
        senderIsBot: false,
        text: messageText,
        mentionsBot: true,
        attachments: [],
        metadata: command.metadata || {},
        receivedAt: new Date().toISOString(),
      };

      const route = routeFromMessage(message);
      return this.dispatchToSession(route.sessionKey, message, { reply: async () => {} });
    }

    if (command.action === 'get_message') {
      const target = this.resolveSessionReference(command.sessionKey);
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
      const target = this.resolveSessionReference(command.sessionKey);
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
      const target = this.resolveSessionReference(command.sessionKey);
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
      const target = this.resolveSessionReference(command.sessionKey);
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

    const commandSessionKey =
      'sessionKey' in command && typeof command.sessionKey === 'string' ? command.sessionKey : undefined;
    const resolvedSessionKey = this.resolveSessionReference(commandSessionKey || sessionKey);
    if (!resolvedSessionKey) {
      return result(false, command.type, undefined, 'sessionKey required');
    }

    const shouldCreateSession = command.type === 'send' || command.type === 'subscribe';
    const session = shouldCreateSession
      ? await this.getOrCreateSession(resolvedSessionKey, {
          reply: async () => {},
          replace: async () => {},
        })
      : this.sessions.get(resolvedSessionKey);

    if (!session) {
      return result(false, command.type, undefined, 'session_not_found');
    }

    if (command.type === 'subscribe') {
      if (command.event !== 'turn_end') {
        return result(false, 'subscribe', undefined, `Unknown event type: ${command.event}. Supported: turn_end`);
      }

      const subscriptionId = command.id ?? `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let subs = this.turnEndSubscriptions.get(resolvedSessionKey);
      if (!subs) {
        subs = new Set<TurnEndSubscription>();
        this.turnEndSubscriptions.set(resolvedSessionKey, subs);
      }

      if (socket) {
        const sub: TurnEndSubscription = { socket, subscriptionId };
        subs.add(sub);
        const cleanup = () => {
          const current = this.turnEndSubscriptions.get(resolvedSessionKey);
          current?.delete(sub);
          if (!current || current.size === 0) {
            this.turnEndSubscriptions.delete(resolvedSessionKey);
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
        return result(false, 'send', undefined, 'message must be a non-empty string');
      }

      const inbound: InboundMessage = {
        id: randomId('session-send'),
        source: 'socket',
        sourceChannelId: resolvedSessionKey,
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
      const wasIdle = session.session.isIdle;
      try {
        await session.session.enqueue(inbound);
        const mode = wasIdle ? 'direct' : command.mode || 'steer';
        return result(true, 'send', {
          delivered: true,
          mode,
        });
      } catch (error) {
        return result(false, 'send', undefined, error instanceof Error ? error.message : 'session_dispatch_failed');
      }
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

  private parseDispatchDirective(text: string): { modeOverride?: 'session' | 'task'; text: string } {
    const trimmed = text.trim();
    if (!trimmed) {
      return { text: '' };
    }

    const sessionMatch = trimmed.match(/^(?:[\/!]chat(?:\s+|:\s*)|chat:\s*)/i);
    if (sessionMatch) {
      return {
        modeOverride: 'session',
        text: trimmed.slice(sessionMatch[0].length).trim(),
      };
    }

    const taskMatch = trimmed.match(/^(?:[\/!]task(?:\s+|:\s*)|task:\s*)/i);
    if (taskMatch) {
      return {
        modeOverride: 'task',
        text: trimmed.slice(taskMatch[0].length).trim(),
      };
    }

    return { text: trimmed };
  }

  private shouldDispatchTaskFlow(
    modeOverride: 'session' | 'task' | undefined,
    message: InboundMessage,
    taskPolicyHint?: TaskPolicyHintInput,
  ) {
    if (!this.tasks) {
      return false;
    }

    const effectiveMode = modeOverride || this.config.CHAT_DISPATCH_MODE;
    if (effectiveMode === 'session') {
      return false;
    }

    if (modeOverride === 'task') {
      return true;
    }

    if (effectiveMode === 'hybrid') {
      return false;
    }

    const policy = resolveTaskPolicy({
      text: message.text,
      messageMetadata: message.metadata,
      taskPolicyHint,
      defaultVerifiedPr: this.config.CHAT_REQUIRE_VERIFIED_PR,
    });
    if (policy.taskIntent === 'unknown' && !hasExplicitTaskCue(message.text)) {
      return false;
    }

    return true;
  }

  private async dispatchToTask(
    sessionKey: string,
    message: InboundMessage,
    callbacks: RunnerContext,
    taskPolicyHint?: TaskPolicyHintInput,
  ): Promise<DispatchResult> {
    if (!this.tasks) {
      return this.dispatchToSession(sessionKey, message, callbacks);
    }

    const text = message.text.trim();
    if (!text.length) {
      await callbacks.reply('Task text is required.');
      return {
        accepted: false,
        reason: 'task_text_required',
        sessionKey,
      };
    }

    try {
      const policy = resolveTaskPolicy({
        text,
        messageMetadata: message.metadata,
        taskPolicyHint,
        defaultVerifiedPr: this.config.CHAT_REQUIRE_VERIFIED_PR,
      });
      const targetRepoFullName = inferTargetRepoFullName(text);
      const engineTimeoutMs = inferTaskTimeoutMs(text, this.config.ENGINE_TIMEOUT_MS, targetRepoFullName);
      const task = await this.tasks.submitTask({
        text,
        sessionKey,
        source: 'transport',
        targetRepoFullName,
        engineTimeoutMs,
        taskIntent: policy.taskIntent,
        requiresVerifiedPr: policy.requiresVerifiedPr,
        requiredArtifacts: policy.requiredArtifacts,
      });

      await this.trackTaskBinding(task.id, sessionKey, message);
      await callbacks.reply(
        `Queued task ${task.id} (repo: ${task.repoId}). I will post progress and final artifacts in this thread.`,
      );
      return {
        accepted: true,
        reason: 'task_queued',
        sessionKey,
        mode: 'task',
        taskId: task.id,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === 'repo_not_found') {
        await callbacks.reply(
          'No repository is registered yet. Register one first: `talonbot repos register --id <repo-id> --path /absolute/path --default true`.',
        );
        return {
          accepted: false,
          reason,
          sessionKey,
          mode: 'task',
        };
      }

      await callbacks.reply(`Task dispatch failed: ${reason}`);
      return {
        accepted: false,
        reason,
        sessionKey,
        mode: 'task',
      };
    }
  }

  private async trackTaskBinding(taskId: string, sessionKey: string, message: InboundMessage) {
    if (!this.taskNotifier) {
      return;
    }

    const binding: TaskThreadBinding = {
      taskId,
      source: message.source,
      channelId: message.sourceChannelId,
      threadId: message.sourceThreadId || undefined,
      sessionKey,
      createdAt: new Date().toISOString(),
    };
    await this.taskNotifier.track(binding);
  }

  registerOutboundSender(source: 'slack' | 'discord' | 'socket', sender: OutboundThreadSender) {
    this.outboundSenders.set(source, sender);
  }

  unregisterOutboundSender(source: 'slack' | 'discord' | 'socket') {
    this.outboundSenders.delete(source);
  }

  async sendOutboundThreadMessage(source: 'slack' | 'discord' | 'socket', message: OutboundThreadMessage) {
    const sender = this.outboundSenders.get(source);
    if (!sender) {
      throw new Error(`outbound_sender_not_registered:${source}`);
    }
    await sender(message);
  }

  listTaskBindings() {
    return this.taskNotifier?.listBindings() || [];
  }

  private buildRunnerCallbacks(callbacks: RunnerContext): RunnerCallbacks {
    return {
      reply: callbacks.reply,
      replace: async () => {},
    };
  }

  resolveSessionReference(reference: string | undefined | null): string | null {
    const target = (reference || '').trim();
    if (!target) {
      return null;
    }

    const alias = this.resolveAlias(target);
    return alias ? alias.sessionKey : target;
  }

  private resolveTargetSession(reference: string | undefined, fallback: string) {
    return this.resolveSessionReference(reference) || fallback;
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

    const targetSessionKey = this.resolveSessionReference(sessionKey) || sessionKey;
    this.aliases[normalizedAlias] = {
      alias: normalizedAlias,
      sessionKey: targetSessionKey,
      createdAt: new Date().toISOString(),
    };

    await this.persistAliases();
    const socketState = this.sessionSockets.get(targetSessionKey);
    if (socketState) {
      await this.createAliasSymlink(normalizedAlias, socketState.socketPath);
    }
    this.logger.info('alias_set', { alias: normalizedAlias, sessionKey: targetSessionKey });
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
    this.logger.info('alias_removed', { alias: normalizedAlias, sessionKey: existing.sessionKey });
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
          buffer += typeof chunk === 'string' ? chunk : chunk.toString();
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

  async stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    await this.taskNotifier?.stop();

    const sessionKeys = Array.from(this.sessions.keys());
    await Promise.all(
      sessionKeys.map(async (sessionKey) => {
        await this.stopSession(sessionKey).catch(() => undefined);
      }),
    );
  }

  private hasSeenEvent(eventId: string) {
    const seenAt = this.seenEventIds.get(eventId);
    if (!seenAt) {
      return false;
    }
    return Date.now() - seenAt <= this.config.SESSION_DEDUPE_WINDOW_MS;
  }

  private touchSeen(eventId: string) {
    const now = Date.now();
    this.seenEventIds.set(eventId, now);
    const cutoff = now - this.config.SESSION_DEDUPE_WINDOW_MS;
    for (const [id, seenAt] of this.seenEventIds.entries()) {
      if (seenAt < cutoff) {
        this.seenEventIds.delete(id);
      }
    }
  }
}
