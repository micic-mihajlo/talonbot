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

  branchName(taskId: string) {
    return `talon/${taskId}`;
  }

  worktreePath(repoId: string, taskId: string) {
    return path.join(this.root, `${repoId}-${taskId}`);
  }

  async createWorktree(repo: RepoRegistration, taskId: string): Promise<WorktreeInfo> {
    const branch = this.branchName(taskId);
    const worktreePath = this.worktreePath(repo.id, taskId);
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

  async listWorktrees() {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const output: Array<{ path: string; name: string; mtimeMs: number }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(this.root, entry.name);
      const stat = await fs.stat(target).catch(() => null);
      if (!stat) continue;
      output.push({
        path: target,
        name: entry.name,
        mtimeMs: stat.mtimeMs,
      });
    }

    return output;
  }

  async cleanupStale(maxAgeHours: number, protectedPaths: Set<string> = new Set()) {
    if (maxAgeHours <= 0) return;

    const threshold = Date.now() - maxAgeHours * 60 * 60 * 1000;
    const entries = await this.listWorktrees();

    for (const entry of entries) {
      if (protectedPaths.has(entry.path)) continue;
      if (entry.mtimeMs < threshold) {
        const target = entry.path;
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
