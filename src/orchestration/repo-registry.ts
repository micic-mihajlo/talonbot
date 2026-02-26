import fs from 'node:fs/promises';
import path from 'node:path';
import { expandPath } from '../utils/path.js';
import type { RepoRegistration, RepoRegistrationInput } from './types.js';

interface RepoRegistryFile {
  version: 1;
  repos: RepoRegistration[];
}

const DEFAULT_FILE: RepoRegistryFile = {
  version: 1,
  repos: [],
};

const REPO_ID_RE = /^[a-zA-Z0-9._-]{2,64}$/;

export class RepoRegistry {
  private readonly repos = new Map<string, RepoRegistration>();

  constructor(private readonly registryFile: string) {}

  async initialize() {
    const file = expandPath(this.registryFile);
    await fs.mkdir(path.dirname(file), { recursive: true });

    try {
      const raw = await fs.readFile(file, { encoding: 'utf8' });
      const parsed = JSON.parse(raw) as RepoRegistryFile;
      if (!parsed || !Array.isArray(parsed.repos)) {
        throw new Error('invalid repo registry format');
      }

      for (const repo of parsed.repos) {
        this.repos.set(repo.id, {
          ...repo,
          path: expandPath(repo.path),
        });
      }
    } catch {
      await this.persist();
    }
  }

  list() {
    return Array.from(this.repos.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(repoId: string) {
    return this.repos.get(repoId) || null;
  }

  getDefault() {
    return this.list().find((repo) => repo.isDefault) ?? this.list()[0] ?? null;
  }

  async register(input: RepoRegistrationInput) {
    const id = input.id.trim();
    if (!REPO_ID_RE.test(id)) {
      throw new Error('repo id must be 2-64 chars [a-zA-Z0-9._-]');
    }

    const repoPath = expandPath(path.resolve(input.path.trim()));
    if (!repoPath) {
      throw new Error('repo path is required');
    }

    const now = new Date().toISOString();
    const existing = this.repos.get(id);

    if (input.isDefault) {
      for (const repo of this.repos.values()) {
        repo.isDefault = false;
      }
    }

    const record: RepoRegistration = {
      id,
      path: repoPath,
      defaultBranch: input.defaultBranch?.trim() || existing?.defaultBranch || 'main',
      remote: input.remote?.trim() || existing?.remote || 'origin',
      isDefault: input.isDefault ?? existing?.isDefault ?? this.repos.size === 0,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    this.repos.set(id, record);
    await this.persist();
    return record;
  }

  async remove(repoId: string) {
    const existed = this.repos.delete(repoId);
    if (!existed) {
      return false;
    }

    if (!this.list().some((repo) => repo.isDefault)) {
      const first = this.list()[0];
      if (first) {
        first.isDefault = true;
      }
    }

    await this.persist();
    return true;
  }

  private async persist() {
    const file = expandPath(this.registryFile);
    const payload: RepoRegistryFile = {
      version: 1,
      repos: this.list(),
    };

    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
    await fs.rename(tmp, file);
  }
}
