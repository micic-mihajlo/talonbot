import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expandPath } from '../utils/path.js';
import type { RepoRegistration, WorktreeInfo } from './types.js';

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = expandPath(rootDir);
  }

  async initialize() {
    await fs.mkdir(this.root, { recursive: true });
  }

  async createWorktree(repo: RepoRegistration, taskId: string): Promise<WorktreeInfo> {
    const branch = `talon/${taskId}`;
    const worktreePath = path.join(this.root, `${repo.id}-${taskId}`);
    const baseRef = `${repo.remote}/${repo.defaultBranch}`;

    await fs.rm(worktreePath, { recursive: true, force: true });

    try {
      await this.git(repo.path, ['worktree', 'add', '-B', branch, worktreePath, baseRef]);
    } catch {
      await this.git(repo.path, ['worktree', 'add', '-B', branch, worktreePath, repo.defaultBranch]);
    }

    return {
      path: worktreePath,
      branch,
      baseRef,
    };
  }

  async cleanupWorktree(repo: RepoRegistration, worktreePath: string, branch?: string) {
    await this.git(repo.path, ['worktree', 'remove', '--force', worktreePath]).catch(() => undefined);
    if (branch) {
      await this.git(repo.path, ['branch', '-D', branch]).catch(() => undefined);
    }
  }

  async cleanupStale(maxAgeHours: number) {
    if (maxAgeHours <= 0) return;

    const threshold = Date.now() - maxAgeHours * 60 * 60 * 1000;
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(this.root, entry.name);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat) continue;
      if (stat.mtimeMs < threshold) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async git(repoPath: string, args: string[]) {
    await execFileAsync('git', ['-C', repoPath, ...args], {
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
  }
}
