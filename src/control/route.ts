import { InboundMessage, NormalizedRoute } from '../shared/protocol';

const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_');

export const routeFromMessage = (message: InboundMessage): NormalizedRoute => {
  const threadToken = message.sourceThreadId && message.sourceThreadId.length > 0 ? sanitize(message.sourceThreadId) : 'main';
  const channel = sanitize(message.sourceChannelId);
  const user = sanitize(message.senderId);
  const source = message.source;

  return {
    source,
    channelId: channel,
    threadId: threadToken,
    userId: user,
    sessionKey: `${source}:${channel}:${threadToken}`,
  };
};
