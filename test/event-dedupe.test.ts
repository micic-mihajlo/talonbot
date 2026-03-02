import { describe, expect, it } from 'vitest';
import { EventDedupeGuard, inboundDedupeKey } from '../src/transports/event-dedupe.js';

describe('event dedupe', () => {
  it('dedupes by source and sourceMessageId regardless of thread identity', () => {
    const a = inboundDedupeKey({
      id: 'a',
      source: 'slack',
      sourceChannelId: 'C1',
      sourceThreadId: undefined,
      sourceMessageId: '1712345.678',
      senderId: 'U1',
      text: 'hello',
      mentionsBot: true,
      attachments: [],
      metadata: {},
      receivedAt: new Date().toISOString(),
    });
    const b = inboundDedupeKey({
      id: 'b',
      source: 'slack',
      sourceChannelId: 'C1',
      sourceThreadId: '1712345.678',
      sourceMessageId: '1712345.678',
      senderId: 'U1',
      text: 'hello',
      mentionsBot: true,
      attachments: [],
      metadata: {},
      receivedAt: new Date().toISOString(),
    });
    expect(a).toBe(b);
  });

  it('uses fallback identity when sourceMessageId is missing', () => {
    const key = inboundDedupeKey({
      id: 'id-1',
      source: 'discord',
      sourceChannelId: 'chan-1',
      sourceThreadId: 'thread-1',
      senderId: 'user-1',
      text: 'hello',
      mentionsBot: true,
      attachments: [],
      metadata: {},
      receivedAt: new Date().toISOString(),
    });
    expect(key).toBe('discord:chan-1:id-1');
  });

  it('drops repeated keys within the configured window', () => {
    const guard = new EventDedupeGuard(1000);
    expect(guard.shouldAccept('k', 0)).toBe(true);
    expect(guard.shouldAccept('k', 500)).toBe(false);
    expect(guard.shouldAccept('k', 1200)).toBe(true);
  });
});
