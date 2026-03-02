import type { InboundMessage } from '../../shared/protocol.js';

export type ChatSdkSource = 'slack' | 'discord';

export interface ThreadIdentity {
  source: ChatSdkSource;
  channelId: string;
  threadId?: string;
  guildId?: string;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

const toRecordString = (input: Record<string, unknown>): Record<string, string> => {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    output[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return output;
};

export const parseThreadIdentity = (source: ChatSdkSource, threadId: string): ThreadIdentity => {
  const parts = threadId.split(':');
  if (source === 'slack') {
    return {
      source,
      channelId: parts[1] || threadId,
      threadId: parts[2] || undefined,
    };
  }
  return {
    source,
    guildId: parts[1] || undefined,
    channelId: parts[2] || threadId,
    threadId: parts[3] || undefined,
  };
};

export const toAdapterThreadId = (identity: ThreadIdentity): string => {
  if (identity.source === 'slack') {
    return `slack:${identity.channelId}:${identity.threadId || identity.channelId}`;
  }
  return `discord:${identity.guildId || '@me'}:${identity.channelId}${identity.threadId ? `:${identity.threadId}` : ''}`;
};

export const toInboundMessage = (
  source: ChatSdkSource,
  input: {
    threadId: string;
    messageId: string;
    text: string;
    isMention: boolean;
    senderId: string;
    senderName?: string;
    senderIsBot?: boolean;
    attachments?: Array<{ id?: string; name?: string; mimeType?: string; url?: string }>;
    raw?: unknown;
    receivedAt?: string;
  },
): InboundMessage => {
  const thread = parseThreadIdentity(source, input.threadId);
  return {
    id: `${source}:${input.messageId}`,
    source,
    sourceChannelId: thread.channelId,
    sourceGuildId: thread.guildId,
    sourceThreadId: thread.threadId,
    sourceMessageId: input.messageId,
    senderId: input.senderId,
    senderName: input.senderName,
    senderIsBot: Boolean(input.senderIsBot),
    text: asText(input.text).trim(),
    mentionsBot: Boolean(input.isMention),
    attachments: (input.attachments || []).map((attachment, idx) => ({
      id: attachment.id || `${source}-${input.messageId}-${idx}`,
      filename: attachment.name,
      contentType: attachment.mimeType,
      url: attachment.url,
    })),
    metadata: toRecordString({
      sdk: 'chat-sdk',
      threadId: input.threadId,
      raw: input.raw,
    }),
    receivedAt: input.receivedAt || new Date().toISOString(),
  };
};
