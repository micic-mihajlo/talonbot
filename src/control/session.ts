import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SerialQueue } from '../utils/queue.js';
import type { RunnerCallbacks, InboundMessage } from '../shared/protocol.js';
import type { AgentEngine } from '../engine/types.js';
import type { AppConfig } from '../config.js';
import { SessionStore } from './store.js';
import { createLogger } from '../utils/logger.js';

interface SessionTranscriptEntry {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface ControlTurnMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface TurnEndEvent {
  message: ControlTurnMessage | null;
  turnIndex: number;
}

type TurnEndListener = (event: TurnEndEvent) => void;

interface SessionState {
  routeKey: string;
  lastActiveAt: string;
  messageCount: number;
  turnIndex: number;
  lastProcessedMessageId?: string;
}

const execFileAsync = promisify(execFile);

const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/gi;

const verifyGitHubPullRequestUrl = async (url: string): Promise<boolean> => {
  try {
    await execFileAsync('gh', ['pr', 'view', url, '--json', 'url'], {
      timeout: 10000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
};

const hasVerifiedGitHubPrUrl = async (text: string): Promise<boolean> => {
  const matches = text.match(GITHUB_PR_URL_RE) || [];
  if (matches.length === 0) return false;

  for (const url of new Set(matches)) {
    if (await verifyGitHubPullRequestUrl(url)) {
      return true;
    }
  }

  return false;
};

const DEFAULT_SUMMARY_PROMPT =
  `Summarize what happened in this conversation since the last user prompt. ` +
  'Include decisions, files touched, command outcomes, and blockers.';

function randomId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export class AgentSession {
  private readonly logger = createLogger('control.session', 'info');
  private readonly queue: SerialQueue;
  private readonly context: string[] = [];
  private readonly seenEventIds = new Map<string, number>();
  private readonly transcript: SessionTranscriptEntry[] = [];
  private readonly onTurnEnd?: TurnEndListener;
  private state: SessionState;
  private stopped = false;
  private currentAbort?: AbortController;
  private running = false;
  private requireVerifiedPrForReplies = false;

  constructor(
    private readonly key: string,
    private readonly routeKey: string,
    private readonly engine: AgentEngine,
    private readonly store: SessionStore,
    private readonly config: AppConfig,
    private readonly callbacks: RunnerCallbacks,
    options?: { onTurnEnd?: TurnEndListener },
  ) {
    this.onTurnEnd = options?.onTurnEnd;
    this.queue = new SerialQueue(
      {
        maxDepth: config.MAX_QUEUE_PER_SESSION,
        dropOldestOnOverflow: true,
      },
      (dropped) => {
        console.warn(`[${key}] queue overflow dropped=${dropped}`);
      },
    );

    this.state = {
      routeKey,
      lastActiveAt: new Date().toISOString(),
      messageCount: 0,
      turnIndex: 0,
    };
  }

  async initialize() {
    const persistedState = await this.store.readSessionState<SessionState>(this.key);
    if (persistedState) {
      this.state = {
        ...persistedState,
        routeKey: this.routeKey,
      };
    }

    const historical = await this.store.readJsonLines(this.key, 'context.jsonl', this.config.SESSION_MAX_MESSAGES);
    const normalized = historical
      .filter(Boolean)
      .map((entry: any) => ({
        kind: typeof entry.kind === 'string' ? entry.kind : '',
        text: typeof entry.text === 'string' ? entry.text : '',
        at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
      }))
      .filter((entry) => entry.text && (entry.kind === 'user' || entry.kind === 'assistant'))
      .slice(-this.config.SESSION_MAX_MESSAGES);

    normalized.forEach((entry) => {
      if (entry.kind === 'user' || entry.kind === 'assistant') {
        this.appendHistory(entry.kind, entry.text, entry.at);
      }
    });

    if (this.state.lastProcessedMessageId) {
      this.seenEventIds.set(this.state.lastProcessedMessageId, Date.now());
    }
  }

  async enqueue(event: InboundMessage) {
    if (this.stopped) {
      return;
    }

    if (this.hasSeen(event.id)) {
      return;
    }

    await this.store.appendLine(this.key, 'log.jsonl', event);

    this.state.lastActiveAt = new Date().toISOString();
    this.state.messageCount += 1;
    this.touchSeen(event.id);
    void this.store.writeSessionState(this.key, this.state);

    if (event.text.length > this.config.MAX_MESSAGE_BYTES) {
      throw new Error('message_too_large');
    }

    const safeText = event.text.slice(0, this.config.MAX_MESSAGE_BYTES);

    return this.queue.enqueue({
      run: async () => {
        await this.processMessage(event, safeText);
      },
    });
  }

  private hasSeen(messageId: string) {
    const now = Date.now();
    const seenAt = this.seenEventIds.get(messageId);
    if (!seenAt) return false;
    return now - seenAt <= this.config.SESSION_DEDUPE_WINDOW_MS;
  }

  private touchSeen(messageId: string) {
    this.seenEventIds.set(messageId, Date.now());
    const cutoff = Date.now() - this.config.SESSION_DEDUPE_WINDOW_MS;
    for (const [id, seenAt] of this.seenEventIds.entries()) {
      if (seenAt < cutoff) {
        this.seenEventIds.delete(id);
      }
    }
  }


  private async enforceArtifactClaims(text: string) {
    const matches = text.match(GITHUB_PR_URL_RE) || [];
    if (matches.length === 0) {
      return text;
    }

    for (const url of new Set(matches)) {
      const ok = await verifyGitHubPullRequestUrl(url);
      if (!ok) {
        this.logger.warn('blocked unverified PR claim in assistant output', {
          sessionKey: this.key,
          routeKey: this.routeKey,
          prUrl: url,
        });
        return `I can’t verify that PR URL yet, so I’m not going to claim it’s ready. I’ll share a verified PR link once it exists.`;
      }
    }

    return text;
  }

  private appendHistory(role: 'user' | 'assistant', content: string, at: string) {
    const text = content.trim();
    if (!text) {
      return;
    }

    this.context.push(`${role}: ${text}`);
    this.transcript.push({ role, content: text, at });

    while (this.context.length > this.config.SESSION_MAX_MESSAGES) {
      this.context.shift();
    }

    while (this.transcript.length > this.config.SESSION_MAX_MESSAGES) {
      this.transcript.shift();
    }
  }

  private async processMessage(event: InboundMessage, normalizedText: string) {
    this.running = true;
    const aborter = new AbortController();
    this.currentAbort = aborter;
    this.appendHistory('user', normalizedText, new Date(event.receivedAt).toISOString());

    if (/don't message me back without the pr url|ping me when you're done|work, don't message|no replies? until pr url|no reply until pr url/i.test(normalizedText)) {
      this.requireVerifiedPrForReplies = true;
    }

    const engineInput = {
      sessionKey: this.key,
      route: this.routeKey,
      text: normalizedText,
      senderId: event.senderId,
      metadata: event.metadata,
      contextLines: this.context.slice(-this.config.SESSION_MAX_MESSAGES),
      rawEvent: event,
      recentAttachments: event.attachments.map((attachment) => attachment.url).filter(Boolean) as string[],
    };

    const turnIndex = this.state.turnIndex + 1;
    this.state.turnIndex = turnIndex;

    try {
      const result = await this.engine.complete(engineInput, aborter.signal);
      const safeText = await this.enforceArtifactClaims(result.text);
      const assistantMessage = {
        role: 'assistant' as const,
        content: safeText,
        timestamp: Date.now(),
      };
      await this.store.appendLine(this.key, 'context.jsonl', {
        kind: 'assistant',
        text: safeText,
        at: new Date().toISOString(),
      });
      this.appendHistory('assistant', safeText, new Date().toISOString());
      if (this.requireVerifiedPrForReplies) {
        const hasVerifiedPr = await hasVerifiedGitHubPrUrl(safeText);
        if (!hasVerifiedPr) {
          this.logger.info('suppressed assistant reply until verified PR URL is available', {
            sessionKey: this.key,
            routeKey: this.routeKey,
          });
          this.state.lastActiveAt = new Date().toISOString();
          this.state.lastProcessedMessageId = event.id;
          void this.store.writeSessionState(this.key, this.state);
          this.running = false;
          this.currentAbort = undefined;
          this.emitTurnEnd({
            message: null,
            turnIndex,
          });
          return;
        }
        this.requireVerifiedPrForReplies = false;
      }

      await this.callbacks.reply(safeText);
      this.state.lastActiveAt = new Date().toISOString();
      this.state.lastProcessedMessageId = event.id;
      void this.store.writeSessionState(this.key, this.state);
      this.running = false;
      this.currentAbort = undefined;

      this.emitTurnEnd({
        message: assistantMessage,
        turnIndex,
      });
    } catch (error) {
      this.running = false;
      this.currentAbort = undefined;

      const err = error as Error;
      this.logger.error('turn execution failed', {
        sessionKey: this.key,
        routeKey: this.routeKey,
        eventId: event.id,
        aborted: aborter.signal.aborted,
        message: err?.message,
        stack: err?.stack,
        senderId: event.senderId,
      });

      if (aborter.signal.aborted) {
      const fallback = 'Turn was aborted by operator.';
      this.appendHistory('assistant', fallback, new Date().toISOString());
      await this.callbacks.reply(fallback);
      await this.store.appendLine(this.key, 'context.jsonl', {
        kind: 'assistant',
        text: fallback,
        at: new Date().toISOString(),
      });
      this.state.lastActiveAt = new Date().toISOString();
      this.state.lastProcessedMessageId = event.id;
      void this.store.writeSessionState(this.key, this.state);
      this.emitTurnEnd({
        message: {
          role: 'assistant',
          content: fallback,
          timestamp: Date.now(),
        },
        turnIndex,
      });
      return;
    }

      const fallback = 'I hit an execution error processing your request.';
      await this.callbacks.reply(fallback);
      this.appendHistory('assistant', fallback, new Date().toISOString());
      await this.store.appendLine(this.key, 'context.jsonl', {
        kind: 'assistant',
        text: fallback,
        at: new Date().toISOString(),
      });
      this.state.lastActiveAt = new Date().toISOString();
      this.state.lastProcessedMessageId = event.id;
      void this.store.writeSessionState(this.key, this.state);
      this.emitTurnEnd({
        message: {
          role: 'assistant',
          content: fallback,
          timestamp: Date.now(),
        },
        turnIndex,
      });
    }
  }

  private emitTurnEnd(event: TurnEndEvent) {
    if (!this.onTurnEnd) return;
    const emit = {
      message: event.message,
      turnIndex: event.turnIndex,
    };
    this.onTurnEnd(emit);
  }

  async getSummary(): Promise<string> {
    const messages = this.getMessagesSinceLastPrompt();
    if (messages.length === 0) {
      throw new Error('No messages to summarize');
    }

    const conversationText = messages
      .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`)
      .join('\n\n');

    const prompt = `${DEFAULT_SUMMARY_PROMPT}\n\n<conversation>\n${conversationText}\n</conversation>`;

    try {
      const result = await this.engine.complete({
        sessionKey: this.key,
        route: this.routeKey,
        text: prompt,
        senderId: 'control',
        metadata: {
          reason: 'control_summary',
        },
        contextLines: [],
        rawEvent: {
          id: randomId('summary'),
          source: 'socket',
          sourceChannelId: this.routeKey,
          senderId: 'control',
          text: prompt,
          mentionsBot: true,
          attachments: [],
          metadata: {},
          receivedAt: new Date().toISOString(),
        },
      });
      return result.text.trim();
    } catch (error) {
      throw error instanceof Error ? error : new Error('Summarization failed');
    }
  }

  getLastAssistantMessage() {
    for (let i = this.transcript.length - 1; i >= 0; i -= 1) {
      const entry = this.transcript[i];
      if (entry.role === 'assistant') {
        return {
          role: entry.role,
          content: entry.content,
          timestamp: Date.parse(entry.at) || Date.now(),
        };
      }
    }

    return null;
  }

  getMessagesSinceLastPrompt() {
    let fromLastUser = -1;
    for (let i = this.transcript.length - 1; i >= 0; i -= 1) {
      if (this.transcript[i].role === 'user') {
        fromLastUser = i;
        break;
      }
    }

    if (fromLastUser === -1) {
      return [];
    }

    const startIndex = fromLastUser;
    return this.transcript.slice(startIndex).map((entry) => ({
      role: entry.role,
      content: entry.content,
      timestamp: Date.parse(entry.at) || Date.now(),
    }));
  }

  async clear(summarize?: boolean) {
    if (this.running || this.queue.size() > 0) {
      throw new Error('Session is busy - wait for turn to complete');
    }

    if (this.transcript.length === 0) {
      throw new Error('No entries in session');
    }

    const alreadyAtRoot = this.state.turnIndex === 0;

    if (summarize) {
      throw new Error('Clear with summarization not supported via RPC - use summarize=false');
    }

    await this.store.clearSessionData(this.key);
    this.context.length = 0;
    this.transcript.length = 0;
    this.seenEventIds.clear();
    this.state = {
      routeKey: this.routeKey,
      lastActiveAt: new Date().toISOString(),
      messageCount: 0,
      turnIndex: 0,
    };
    await this.store.writeSessionState(this.key, this.state);

    return {
      cleared: true,
      alreadyAtRoot,
      targetId: 'root',
    };
  }

  async abort() {
    const hadActiveTask = this.running || this.queue.size() > 0;
    const hadAbort = !!this.currentAbort;
    if (this.currentAbort) {
      this.currentAbort.abort();
    }
    this.queue.clear();
    this.running = false;
    return hadActiveTask || hadAbort;
  }

  get routeKeyValue() {
    return this.routeKey;
  }

  get queueSize() {
    return this.queue.size();
  }

  get lastActiveAt() {
    return this.state.lastActiveAt;
  }

  get isIdle() {
    return !this.running && this.queue.size() === 0;
  }

  stop() {
    this.stopped = true;
    void this.abort();
  }
}
