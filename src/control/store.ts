import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ensureDir, joinSafe } from '../utils/path';

const stringify = (value: unknown) => `${JSON.stringify(value)}\n`;

export class SessionStore {
  constructor(private readonly baseDir: string) {}

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

  sanitizeKey(sessionKey: string) {
    return joinSafe(sessionKey);
  }
}
