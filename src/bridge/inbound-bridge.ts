export interface InboundEnvelope {
  messageId: string;
  source: string;
  type: string;
  payload: unknown;
  timestamp: number;
}

export interface BridgeAcceptResult {
  ack: boolean;
  status: 'accepted' | 'duplicate' | 'poison' | 'rejected';
  reason?: string;
  envelope?: InboundEnvelope;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export class InboundBridge {
  private readonly seen = new Map<string, number>();

  constructor(private readonly sharedSecret: string, private readonly dedupeTtlMs = 20 * 60 * 1000) {}

  accept(raw: unknown, signature?: string): BridgeAcceptResult {
    this.prune();

    if (this.sharedSecret && this.sharedSecret !== signature) {
      return {
        ack: false,
        status: 'rejected',
        reason: 'invalid_signature',
      };
    }

    const envelope = this.normalize(raw);
    if (!envelope) {
      return {
        ack: true,
        status: 'poison',
        reason: 'invalid_envelope',
      };
    }

    if (this.seen.has(envelope.messageId)) {
      return {
        ack: true,
        status: 'duplicate',
        envelope,
      };
    }

    this.seen.set(envelope.messageId, Date.now() + this.dedupeTtlMs);
    return {
      ack: true,
      status: 'accepted',
      envelope,
    };
  }

  private normalize(raw: unknown): InboundEnvelope | null {
    if (!raw || typeof raw !== 'object') return null;

    const payload = raw as {
      messageId?: unknown;
      message_id?: unknown;
      source?: unknown;
      type?: unknown;
      payload?: unknown;
      timestamp?: unknown;
      broker_timestamp?: unknown;
    };

    const messageId = String(payload.messageId || payload.message_id || '').trim();
    const source = String(payload.source || '').trim();
    const type = String(payload.type || '').trim();

    if (!messageId || !source || !type || !('payload' in payload)) {
      return null;
    }

    const rawTs = Number(payload.timestamp ?? payload.broker_timestamp ?? Date.now());
    const timestamp = clamp(Number.isFinite(rawTs) ? rawTs : Date.now(), 0, Date.now() + 60_000);

    return {
      messageId,
      source,
      type,
      payload: payload.payload,
      timestamp,
    };
  }

  private prune() {
    const now = Date.now();
    for (const [messageId, expiresAt] of this.seen.entries()) {
      if (expiresAt <= now) {
        this.seen.delete(messageId);
      }
    }
  }
}
