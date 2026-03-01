import fs from 'node:fs/promises';
import path from 'node:path';
import { expandPath } from '../utils/path.js';

export type TransportOutboxStatus = 'queued' | 'retrying' | 'sent' | 'poison';

export interface TransportOutboxEnvelope<TPayload> {
  id: string;
  idempotencyKey: string;
  status: TransportOutboxStatus;
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
  payload: TPayload;
  lastError?: string;
}

interface PersistedOutbox<TPayload> {
  version: 1;
  records: Array<TransportOutboxEnvelope<TPayload>>;
}

const defaultPayload = <TPayload>(): PersistedOutbox<TPayload> => ({
  version: 1,
  records: [],
});

const backoffMs = (attempt: number, baseMs: number, maxMs: number) => {
  const power = Math.max(0, attempt - 1);
  return Math.min(maxMs, baseMs * 2 ** power);
};

export class TransportOutbox<TPayload> {
  private readonly records = new Map<string, TransportOutboxEnvelope<TPayload>>();
  private readonly byKey = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private pumping = false;
  private closed = false;

  constructor(
    private readonly stateFile: string,
    private readonly sender: (payload: TPayload) => Promise<void>,
    private readonly retryBaseMs: number,
    private readonly retryMaxMs: number,
    private readonly maxRetries: number,
    private readonly logger: {
      info: (message: string, meta?: unknown) => void;
      warn: (message: string, meta?: unknown) => void;
      error: (message: string, meta?: unknown) => void;
    },
  ) {}

  private randomId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  }

  async initialize() {
    this.closed = false;
    const file = expandPath(this.stateFile);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const raw = await fs.readFile(file, { encoding: 'utf8' }).catch(() => '');
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistedOutbox<TPayload>;
        for (const record of parsed.records || []) {
          this.records.set(record.id, record);
          this.byKey.set(record.idempotencyKey, record.id);
        }
      } catch {
        // reset corrupted file
      }
    }

    await this.persistSafe();
    this.timer = setInterval(() => {
      void this.pump();
    }, Math.max(200, Math.floor(this.retryBaseMs / 2)));
    void this.pump();
  }

  async stop() {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.persistSafe();
  }

  list() {
    return Array.from(this.records.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async enqueue(input: { idempotencyKey: string; payload: TPayload }) {
    const key = input.idempotencyKey.trim();
    if (!key) {
      throw new Error('outbox_idempotency_key_required');
    }

    const existingId = this.byKey.get(key);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing && existing.status !== 'poison') {
        return existing;
      }
    }

    const now = new Date().toISOString();
    const record: TransportOutboxEnvelope<TPayload> = {
      id: this.randomId('outbox'),
      idempotencyKey: key,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
      payload: input.payload,
    };
    this.records.set(record.id, record);
    this.byKey.set(key, record.id);
    await this.persistSafe();
    void this.pump();
    return record;
  }

  private async pump() {
    if (this.closed) return;
    if (this.pumping) return;
    this.pumping = true;
    try {
      const now = Date.now();
      const ready = this.list().filter((record) => {
        if (record.status !== 'queued' && record.status !== 'retrying') return false;
        const next = Date.parse(record.nextAttemptAt);
        return Number.isFinite(next) && next <= now;
      });

      for (const record of ready) {
        await this.attemptSend(record.id);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async attemptSend(recordId: string) {
    if (this.closed) return;
    const record = this.records.get(recordId);
    if (!record) return;

    try {
      await this.sender(record.payload);
      record.status = 'sent';
      record.attempts += 1;
      record.updatedAt = new Date().toISOString();
      record.lastError = undefined;
      await this.persistSafe();
      this.logger.info('transport outbox sent', { id: record.id, key: record.idempotencyKey, attempts: record.attempts });
      return;
    } catch (error) {
      record.attempts += 1;
      record.updatedAt = new Date().toISOString();
      record.lastError = error instanceof Error ? error.message : String(error);

      if (record.attempts > this.maxRetries) {
        record.status = 'poison';
        record.nextAttemptAt = new Date().toISOString();
        await this.persistSafe();
        this.logger.error('transport outbox moved message to poison', {
          id: record.id,
          key: record.idempotencyKey,
          attempts: record.attempts,
          error: record.lastError,
        });
        return;
      }

      const waitMs = backoffMs(record.attempts, this.retryBaseMs, this.retryMaxMs);
      record.status = 'retrying';
      record.nextAttemptAt = new Date(Date.now() + waitMs).toISOString();
      await this.persistSafe();
      this.logger.warn('transport outbox retry scheduled', {
        id: record.id,
        key: record.idempotencyKey,
        attempts: record.attempts,
        waitMs,
        error: record.lastError,
      });
    }
  }

  private async persist() {
    const file = expandPath(this.stateFile);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    const payload: PersistedOutbox<TPayload> = {
      version: 1,
      records: this.list(),
    };
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
    await fs.rename(tmp, file);
  }

  private async persistSafe() {
    try {
      await this.persist();
    } catch (error) {
      if (this.closed) {
        return;
      }
      this.logger.warn('transport outbox persist failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
