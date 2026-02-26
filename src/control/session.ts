import { SerialQueue } from '../utils/queue';
import type { RunnerCallbacks, InboundMessage } from '../shared/protocol';
import type { AgentEngine } from '../engine/types';
import type { AppConfig } from '../config';
import { SessionStore } from './store';

interface SessionState {
  routeKey: string;
  lastActiveAt: string;
  messageCount: number;
  lastProcessedMessageId?: string;
}

export class AgentSession {
  private readonly queue: SerialQueue;
  private readonly context: string[] = [];
  private readonly seenEventIds = new Map<string, number>();
  private state: SessionState;
  private stopped = false;

  constructor(
    private readonly key: string,
    private readonly routeKey: string,
    private readonly engine: AgentEngine,
    private readonly store: SessionStore,
    private readonly config: AppConfig,
    private readonly callbacks: RunnerCallbacks,
  ) {
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
    };
  }

  async initialize() {
    const persistedState = await this.store.readSessionState<SessionState>(this.key);
    if (persistedState) {
      this.state = persistedState;
    }

    const historical = await this.store.readJsonLines(this.key, 'context.jsonl', this.config.SESSION_MAX_MESSAGES);
    const normalized = historical
      .filter(Boolean)
      .map((entry: any) => `${entry.kind}: ${entry.text}`)
      .slice(-this.config.SESSION_MAX_MESSAGES);
    this.context.push(...normalized);

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

  async processMessage(event: InboundMessage, normalizedText: string) {
    this.context.push(`user ${event.senderId}: ${normalizedText}`);
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

    try {
      const result = await this.engine.complete(engineInput);
      this.context.push(`assistant: ${result.text}`);
      await this.store.appendLine(this.key, 'context.jsonl', {
        kind: 'assistant',
        text: result.text,
        at: new Date().toISOString(),
      });
      await this.callbacks.reply(result.text);
      this.trimContext();
    } catch (error) {
      const fallback = 'I hit an execution error processing your request.';
      await this.callbacks.reply(fallback);
      this.context.push(`assistant: ${fallback}`);
      await this.store.appendLine(this.key, 'context.jsonl', {
        kind: 'assistant',
        text: fallback,
        at: new Date().toISOString(),
      });
    }

    this.state.lastActiveAt = new Date().toISOString();
    this.state.lastProcessedMessageId = event.id;
    void this.store.writeSessionState(this.key, this.state);
  }

  private trimContext() {
    while (this.context.length > this.config.SESSION_MAX_MESSAGES) {
      this.context.shift();
    }
  }

  get queueSize() {
    return this.queue.size();
  }

  get lastActiveAt() {
    return this.state.lastActiveAt;
  }

  stop() {
    this.stopped = true;
  }
}
