export type TransportType = 'slack' | 'discord' | 'socket';

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
  sessionKey?: string;
  alias?: string;
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

export type ControlRpcCommandType = 'send' | 'get_message' | 'get_summary' | 'clear' | 'abort' | 'subscribe';

export interface ControlRpcResponse {
  type: 'response';
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
  id?: string;
}

export interface ControlRpcEvent {
  type: 'event';
  event: string;
  data?: unknown;
  subscriptionId?: string;
}

export interface ControlRpcSendCommand {
  type: 'send';
  message: string;
  mode?: 'steer' | 'follow_up';
  id?: string;
  sessionKey?: string;
}

export interface ControlRpcGetMessageCommand {
  type: 'get_message';
  id?: string;
  sessionKey?: string;
}

export interface ControlRpcGetSummaryCommand {
  type: 'get_summary';
  id?: string;
  sessionKey?: string;
}

export interface ControlRpcClearCommand {
  type: 'clear';
  summarize?: boolean;
  id?: string;
  sessionKey?: string;
}

export interface ControlRpcAbortCommand {
  type: 'abort';
  id?: string;
  sessionKey?: string;
}

export interface ControlRpcSubscribeCommand {
  type: 'subscribe';
  event: 'turn_end';
  id?: string;
  sessionKey?: string;
}

export type ControlRpcCommand =
  | ControlRpcSendCommand
  | ControlRpcGetMessageCommand
  | ControlRpcGetSummaryCommand
  | ControlRpcClearCommand
  | ControlRpcAbortCommand
  | ControlRpcSubscribeCommand;

export interface ControlRpcUnknownCommand {
  type: string;
  id?: string;
  sessionKey?: string;
  [key: string]: unknown;
}

export type ControlRpcParsedCommand = ControlRpcCommand | ControlRpcUnknownCommand;

export interface LegacyControlCommand {
  action:
    | 'send'
    | 'stop'
    | 'health'
    | 'list'
    | 'alias_set'
    | 'alias_unset'
    | 'alias_resolve'
    | 'alias_list'
    | 'get_message'
    | 'get_summary'
    | 'clear'
    | 'abort'
    | 'subscribe';
  source?: TransportType;
  channelId?: string;
  threadId?: string;
  senderId?: string;
  sessionKey?: string;
  text?: string;
  metadata?: Record<string, string>;
  alias?: string;
  message?: string;
  mode?: 'steer' | 'follow_up';
  summarize?: boolean;
  event?: 'turn_end';
  id?: string;
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
