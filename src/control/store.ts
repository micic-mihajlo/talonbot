import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ensureDir, joinSafe } from '../utils/path.js';
import type { AliasMap } from './aliases.js';
import type { TaskStatus, TaskRecord } from '../orchestration/types.js';

const stringify = (value: unknown) => `${JSON.stringify(value)}\n`;

export interface TaskThreadBinding {
  taskId: string;
  source: 'slack' | 'discord' | 'socket';
  channelId: string;
  threadId?: string;
  sessionKey: string;
  createdAt: string;
  lastNotifiedStatus?: TaskStatus;
  lastNotifiedAt?: string;
}

export class SessionStore {
  private readonly aliasFile: string;
  private readonly taskBindingsFile: string;
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.aliasFile = path.join(this.baseDir, 'aliases.json');
    this.taskBindingsFile = path.join(this.baseDir, 'task-bindings.json');
  }

  async init() {
    await ensureDir(this.baseDir);
  }

  resolvePath(sessionKey: string) {
    const hashed = createHash('sha1').update(sessionKey).digest('hex');
    return path.join(this.baseDir, hashed);
  }

  async ensureSessionDir(sessionKey: string) {
    const dir = this.resolvePath(sessionKey);
    await ensureDir(dir);
    return dir;
  }

  async appendLine(sessionKey: string, fileName: string, payload: unknown) {
    const dir = await this.ensureSessionDir(sessionKey);
    const file = path.join(dir, fileName);
    await fs.appendFile(file, stringify(payload), { encoding: 'utf8' });
  }

  async readJsonLines(sessionKey: string, fileName: string, limit = 500) {
    const dir = this.resolvePath(sessionKey);
    const file = path.join(dir, fileName);
    if (!existsSync(file)) return [];

    const raw = await fs.readFile(file, { encoding: 'utf8' });
    const lines = raw.split('\n').filter(Boolean).slice(-limit);
    return lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  async writeSessionState(sessionKey: string, state: unknown) {
    const dir = await this.ensureSessionDir(sessionKey);
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), { encoding: 'utf8' });
  }

  async readSessionState<T>(sessionKey: string): Promise<T | null> {
    const dir = this.resolvePath(sessionKey);
    const stateFile = path.join(dir, 'state.json');
    if (!existsSync(stateFile)) return null;
    const raw = await fs.readFile(stateFile, { encoding: 'utf8' });
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async readAliasMap(): Promise<AliasMap> {
    if (!existsSync(this.aliasFile)) {
      return {};
    }

    try {
      const raw = await fs.readFile(this.aliasFile, { encoding: 'utf8' });
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as AliasMap) : {};
    } catch {
      return {};
    }
  }

  async writeAliasMap(aliases: AliasMap) {
    await ensureDir(this.baseDir);
    await fs.writeFile(this.aliasFile, JSON.stringify(aliases, null, 2), { encoding: 'utf8' });
  }

  private isTaskStatus(value: unknown): value is TaskStatus {
    return (
      value === 'queued' ||
      value === 'running' ||
      value === 'blocked' ||
      value === 'done' ||
      value === 'failed' ||
      value === 'cancelled'
    );
  }

  private normalizeTaskBinding(raw: unknown): TaskThreadBinding | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const candidate = raw as Partial<TaskThreadBinding> & { source?: unknown };
    const source = candidate.source === 'slack' || candidate.source === 'discord' || candidate.source === 'socket' ? candidate.source : null;
    if (!source) {
      return null;
    }

    if (typeof candidate.taskId !== 'string' || !candidate.taskId.trim()) {
      return null;
    }
    if (typeof candidate.channelId !== 'string' || !candidate.channelId.trim()) {
      return null;
    }
    if (typeof candidate.sessionKey !== 'string' || !candidate.sessionKey.trim()) {
      return null;
    }

    return {
      taskId: candidate.taskId,
      source,
      channelId: candidate.channelId,
      threadId: typeof candidate.threadId === 'string' && candidate.threadId.trim() ? candidate.threadId : undefined,
      sessionKey: candidate.sessionKey,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
      lastNotifiedStatus: this.isTaskStatus(candidate.lastNotifiedStatus) ? candidate.lastNotifiedStatus : undefined,
      lastNotifiedAt: typeof candidate.lastNotifiedAt === 'string' ? candidate.lastNotifiedAt : undefined,
    };
  }

  async readTaskBindings(): Promise<TaskThreadBinding[]> {
    if (!existsSync(this.taskBindingsFile)) {
      return [];
    }

    try {
      const raw = await fs.readFile(this.taskBindingsFile, { encoding: 'utf8' });
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .map((entry) => this.normalizeTaskBinding(entry))
        .filter((entry): entry is TaskThreadBinding => Boolean(entry));
    } catch {
      return [];
    }
  }

  private async writeTaskBindings(bindings: TaskThreadBinding[]) {
    await ensureDir(this.baseDir);
    const payload = bindings
      .map((binding) => this.normalizeTaskBinding(binding))
      .filter((binding): binding is TaskThreadBinding => Boolean(binding));
    await fs.writeFile(this.taskBindingsFile, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
  }

  async upsertTaskBinding(binding: TaskThreadBinding) {
    const normalized = this.normalizeTaskBinding(binding);
    if (!normalized) {
      throw new Error('invalid_task_binding');
    }

    const existing = await this.readTaskBindings();
    const next = existing.filter((item) => item.taskId !== normalized.taskId);
    next.push(normalized);
    await this.writeTaskBindings(next);
  }

  async removeTaskBinding(taskId: string) {
    const existing = await this.readTaskBindings();
    const next = existing.filter((item) => item.taskId !== taskId);
    if (next.length === existing.length) {
      return false;
    }
    await this.writeTaskBindings(next);
    return true;
  }

  async pruneTaskBindings(tasks: TaskRecord[]) {
    const taskMap = new Map<string, TaskRecord>(tasks.map((task) => [task.id, task]));
    const existing = await this.readTaskBindings();
    const next = existing.filter((binding) => {
      const task = taskMap.get(binding.taskId);
      if (!task) return false;
      return task.status !== 'done' && task.status !== 'failed' && task.status !== 'cancelled';
    });

    if (next.length !== existing.length) {
      await this.writeTaskBindings(next);
    }
  }

  async clearSessionData(sessionKey: string) {
    const dir = this.resolvePath(sessionKey);
    const contextFile = path.join(dir, 'context.jsonl');
    const logFile = path.join(dir, 'log.jsonl');
    await this.deleteIfExists(contextFile);
    await this.deleteIfExists(logFile);
  }

  async deleteIfExists(filePath: string) {
    try {
      await fs.rm(filePath, { recursive: false, force: true });
    } catch {
      // ignore
    }
  }

  sanitizeKey(sessionKey: string) {
    return joinSafe(sessionKey);
  }
}
