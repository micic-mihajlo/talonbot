import type { InboundMessage } from '../shared/protocol.js';

const normalizeThread = (threadId: string | undefined | null) => (threadId || 'main').trim() || 'main';

export const inboundDedupeKey = (message: InboundMessage) =>
  `${message.source}:${message.sourceChannelId}:${normalizeThread(message.sourceThreadId)}:${message.sourceMessageId || message.id}`;

export class EventDedupeGuard {
  private readonly seen = new Map<string, number>();
  private dropped = 0;
  private accepted = 0;

  constructor(private readonly windowMs: number) {}

  shouldAccept(key: string, now = Date.now()): boolean {
    this.compact(now);
    const previous = this.seen.get(key);
    if (typeof previous === 'number' && now - previous <= this.windowMs) {
      this.dropped += 1;
      return false;
    }
    this.seen.set(key, now);
    this.accepted += 1;
    return true;
  }

  private compact(now: number) {
    for (const [key, ts] of this.seen.entries()) {
      if (now - ts > this.windowMs) {
        this.seen.delete(key);
      }
    }
  }

  stats() {
    return {
      windowMs: this.windowMs,
      entries: this.seen.size,
      accepted: this.accepted,
      dropped: this.dropped,
    };
  }
}
