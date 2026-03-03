import { describe, expect, it } from 'vitest';

import {
  chunkDiscordContent,
  DISCORD_CONTENT_HARD_LIMIT,
  sendDiscordContentInChunks,
} from '../src/transports/discord/chunking.js';

describe('discord outbound chunking', () => {
  it('keeps <= limit payload unchanged', () => {
    const input = 'a'.repeat(DISCORD_CONTENT_HARD_LIMIT);
    const chunks = chunkDiscordContent(input);
    expect(chunks).toEqual([input]);
  });

  it('splits > limit payload at paragraph boundary when possible', () => {
    const prefix = 'x'.repeat(DISCORD_CONTENT_HARD_LIMIT - 10);
    const suffix = 'y'.repeat(64);
    const input = `${prefix}\n\n${suffix}`;

    const chunks = chunkDiscordContent(input);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].endsWith('\n\n')).toBe(true);
    expect(chunks[0].length).toBeLessThanOrEqual(DISCORD_CONTENT_HARD_LIMIT);
    expect(chunks[1].length).toBeLessThanOrEqual(DISCORD_CONTENT_HARD_LIMIT);
    expect(chunks.join('')).toBe(input);
  });

  it('splits huge payload into deterministic N chunks', () => {
    const input = 'z'.repeat(DISCORD_CONTENT_HARD_LIMIT * 5 + 123);
    const chunks = chunkDiscordContent(input);

    expect(chunks).toHaveLength(6);
    expect(chunks.slice(0, 5).every((chunk) => chunk.length === DISCORD_CONTENT_HARD_LIMIT)).toBe(true);
    expect(chunks[5].length).toBe(123);
    expect(chunks.join('')).toBe(input);
  });

  it('never emits over-limit payloads while sending', async () => {
    const input = Array.from({ length: 200 }, (_, idx) => `section-${idx} ${'b'.repeat(120)}`).join('\n\n');
    const sent: string[] = [];

    const result = await sendDiscordContentInChunks(input, async (chunk) => {
      sent.push(chunk);
    });

    expect(result.chunks).toBe(sent.length);
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((chunk) => chunk.length <= DISCORD_CONTENT_HARD_LIMIT)).toBe(true);
    expect(sent.join('')).toBe(input);
  });
});
