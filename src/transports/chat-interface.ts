export interface ChatTransportHealth {
  healthy: boolean;
  started: boolean;
  details?: Record<string, unknown>;
}

export interface ChatTransport {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): ChatTransportHealth;
  name(): string;
}
