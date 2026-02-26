export type TransportType = 'slack' | 'discord';

export interface InboundAttachment {
  id: string;
  filename?: string;
  contentType?: string;
  url?: string;
}

export interface InboundMessage {
  id: string;
  source: TransportType;
  sourceChannelId: string;
  sourceTeamId?: string;
  sourceGuildId?: string;
  sourceThreadId?: string | null;
  sourceMessageId?: string;
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
  text: string;
  mentionsBot: boolean;
  attachments: InboundAttachment[];
  metadata: Record<string, string>;
  receivedAt: string;
}

export interface ControlDispatchPayload {
  source: TransportType;
  channelId: string;
  threadId?: string;
  userId?: string;
  senderId?: string;
  text: string;
  metadata?: Record<string, string>;
}

export interface ControlDispatchResult {
  accepted: boolean;
  reason?: string;
  sessionKey?: string;
}

export interface OutboundMessage {
  channelId: string;
  threadId?: string;
  text: string;
  ephemeral?: boolean;
}

export interface NormalizedRoute {
  source: TransportType;
  channelId: string;
  threadId?: string;
  userId: string;
  sessionKey: string;
}

export type EngineResult = {
  kind: 'text' | 'error' | 'ignore';
  text?: string;
};

export interface RunnerCallbacks {
  reply: (text: string) => Promise<void>;
  replace?: (text: string) => Promise<void>;
}

export interface QueueContext {
  startedAt: string;
  route: NormalizedRoute;
  eventCount: number;
}
