import fs from 'node:fs/promises';
import path from 'node:path';
import { InboundBridge, type InboundEnvelope } from './inbound-bridge.js';

export type BridgeDeliveryState = 'queued' | 'processing' | 'acked' | 'retrying' | 'poison' | 'rejected' | 'duplicate';

export interface BridgeDispatchResult {
  taskId?: string;
}

export interface BridgeSupervisorOptions {
  sharedSecret: string;
  stateFile: string;
  retryBaseMs: number;
  retryMaxMs: number;
  maxRetries: number;
  onDispatch: (envelope: InboundEnvelope, metadata?: { repoId?: string }) => Promise<BridgeDispatchResult>;
}

interface BridgeRecord {
  messageId: string;
  source: string;
  type: string;
  payload: unknown;
  timestamp: number;
  receivedAt: string;
  updatedAt: string;
  state: BridgeDeliveryState;
  attempts: number;
  nextAttemptAt?: number;
  error?: string;
  taskId?: string;
  repoId?: string;
}

interface BridgeStateFile {
  version: 1;
  records: BridgeRecord[];
}

export interface BridgeHealth {
  queued: number;
  retrying: number;
  processing: number;
  acked: number;
  poison: number;
  rejected: number;
  duplicate: number;
  lastUpdatedAt?: string;
}

export interface BridgeAcceptResponse {
  ack: boolean;
  status: BridgeDeliveryState;
  reason?: string;
  messageId?: string;
}

export class BridgeSupervisor {
  private readonly verifier: InboundBridge;
  private readonly records = new Map<string, BridgeRecord>();
  private timer?: ReturnType<typeof setInterval>;
  private processing = false;

  constructor(private readonly options: BridgeSupervisorOptions) {
    this.verifier = new InboundBridge(options.sharedSecret);
  }

  async initialize() {
    await fs.mkdir(path.dirname(this.options.stateFile), { recursive: true });
    await this.load();
    this.timer = setInterval(() => {
      void this.processQueue();
    }, 500);
    await this.processQueue();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getHealth(): BridgeHealth {
    const values = Array.from(this.records.values());
    return {
      queued: values.filter((r) => r.state === 'queued').length,
      retrying: values.filter((r) => r.state === 'retrying').length,
      processing: values.filter((r) => r.state === 'processing').length,
      acked: values.filter((r) => r.state === 'acked').length,
      poison: values.filter((r) => r.state === 'poison').length,
      rejected: values.filter((r) => r.state === 'rejected').length,
      duplicate: values.filter((r) => r.state === 'duplicate').length,
      lastUpdatedAt: values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt,
    };
  }

  listRecords(limit = 200) {
    return Array.from(this.records.values())
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .slice(0, limit);
  }

  async accept(raw: unknown, signature?: string, metadata?: { repoId?: string }): Promise<BridgeAcceptResponse> {
    const accepted = this.verifier.accept(raw, signature);

    if (accepted.status === 'rejected') {
      const messageId = this.extractMessageId(raw) || `rejected-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      const now = new Date().toISOString();
      this.records.set(messageId, {
        messageId,
        source: 'unknown',
        type: 'unknown',
        payload: raw,
        timestamp: Date.now(),
        receivedAt: now,
        updatedAt: now,
        state: 'rejected',
        attempts: 0,
        error: accepted.reason || 'invalid_signature',
      });
      await this.persist();
      return {
        ack: false,
        status: 'rejected',
        reason: accepted.reason,
        messageId,
      };
    }

    if (accepted.status === 'poison') {
      const messageId = this.extractMessageId(raw) || `poison-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
      const now = new Date().toISOString();
      this.records.set(messageId, {
        messageId,
        source: 'unknown',
        type: 'unknown',
        payload: raw,
        timestamp: Date.now(),
        receivedAt: now,
        updatedAt: now,
        state: 'poison',
        attempts: 0,
        error: accepted.reason || 'invalid_envelope',
      });
      await this.persist();
      return {
        ack: true,
        status: 'poison',
        reason: accepted.reason,
        messageId,
      };
    }

    if (!accepted.envelope) {
      return {
        ack: false,
        status: 'rejected',
        reason: 'missing_envelope',
      };
    }

    const messageId = accepted.envelope.messageId;

    if (accepted.status === 'duplicate') {
      const existing = this.records.get(messageId);
      if (existing) {
        existing.updatedAt = new Date().toISOString();
        existing.state = 'duplicate';
        this.records.set(messageId, existing);
      } else {
        const now = new Date().toISOString();
        this.records.set(messageId, {
          messageId,
          source: accepted.envelope.source,
          type: accepted.envelope.type,
          payload: accepted.envelope.payload,
          timestamp: accepted.envelope.timestamp,
          receivedAt: now,
          updatedAt: now,
          state: 'duplicate',
          attempts: 0,
        });
      }
      await this.persist();
      return {
        ack: true,
        status: 'duplicate',
        messageId,
      };
    }

    const now = new Date().toISOString();
    this.records.set(messageId, {
      messageId,
      source: accepted.envelope.source,
      type: accepted.envelope.type,
      payload: accepted.envelope.payload,
      timestamp: accepted.envelope.timestamp,
      receivedAt: now,
      updatedAt: now,
      state: 'queued',
      attempts: 0,
      nextAttemptAt: Date.now(),
      repoId: metadata?.repoId,
    });

    await this.persist();
    await this.processQueue();

    return {
      ack: true,
      status: 'queued',
      messageId,
    };
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;

    try {
      const nowMs = Date.now();
      const due = Array.from(this.records.values())
        .filter((record) => (record.state === 'queued' || record.state === 'retrying') && (record.nextAttemptAt || 0) <= nowMs)
        .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

      for (const record of due) {
        record.state = 'processing';
        record.updatedAt = new Date().toISOString();
        await this.persist();

        try {
          const result = await this.options.onDispatch(
            {
              messageId: record.messageId,
              source: record.source,
              type: record.type,
              payload: record.payload,
              timestamp: record.timestamp,
            },
            { repoId: record.repoId },
          );

          record.state = 'acked';
          record.taskId = result.taskId;
          record.updatedAt = new Date().toISOString();
          record.error = undefined;
          record.nextAttemptAt = undefined;
          await this.persist();
        } catch (error) {
          record.attempts += 1;
          record.updatedAt = new Date().toISOString();
          record.error = error instanceof Error ? error.message : String(error);

          if (record.attempts > this.options.maxRetries) {
            record.state = 'poison';
            record.nextAttemptAt = undefined;
          } else {
            const backoff = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** (record.attempts - 1));
            record.state = 'retrying';
            record.nextAttemptAt = Date.now() + backoff;
          }

          await this.persist();
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async load() {
    const raw = await fs.readFile(this.options.stateFile, { encoding: 'utf8' }).catch(() => '');
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as BridgeStateFile;
      for (const record of parsed.records || []) {
        this.records.set(record.messageId, record);
      }
    } catch {
      this.records.clear();
    }
  }

  private async persist() {
    const payload: BridgeStateFile = {
      version: 1,
      records: Array.from(this.records.values()),
    };

    const tmp = `${this.options.stateFile}.${Date.now()}-${Math.random().toString(16).slice(2, 6)}.tmp`;
    await fs.mkdir(path.dirname(this.options.stateFile), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
    await fs.rename(tmp, this.options.stateFile);
  }

  private extractMessageId(raw: unknown) {
    if (!raw || typeof raw !== 'object') return '';
    const source = raw as { messageId?: unknown; message_id?: unknown };
    return String(source.messageId || source.message_id || '').trim();
  }
}
