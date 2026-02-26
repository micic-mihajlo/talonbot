import type { InboundMessage } from '../shared/protocol.js';

export interface EngineInput {
  sessionKey: string;
  route: string;
  text: string;
  senderId: string;
  metadata: Record<string, string>;
  contextLines: string[];
  recentAttachments?: string[];
  rawEvent: InboundMessage;
}

export interface EngineOutput {
  text: string;
}

export interface AgentEngine {
  complete(input: EngineInput, signal?: AbortSignal): Promise<EngineOutput>;
  ping(): Promise<boolean>;
}
