import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface PullRequestCheckRecord {
  conclusion?: string;
  status?: string;
  name?: string;
}

interface PullRequestView {
  url?: string;
  statusCheckRollup?: PullRequestCheckRecord[];
}

export interface PullRequestCheckState {
  summary: string;
  passed: boolean;
  pending: boolean;
  total: number;
  failed: string[];
}

export class GitHubAutomation {
  async listChangedFiles(worktreePath: string): Promise<string[]> {
    const status = await this.git(worktreePath, ['status', '--porcelain']);
    return status.stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  }

  async commitAll(worktreePath: string, message: string): Promise<string | null> {
    const status = await this.git(worktreePath, ['status', '--porcelain']);
    if (!status.stdout.trim()) {
      return null;
    }

    await this.git(worktreePath, ['add', '-A']);
    await this.git(worktreePath, ['commit', '-m', message]);
    const sha = await this.git(worktreePath, ['rev-parse', 'HEAD']);
    return sha.stdout.trim() || null;
  }

  async pushBranch(worktreePath: string, remote: string, branch: string) {
    await this.git(worktreePath, ['push', '-u', remote, branch]);
  }

  async openPullRequest(
    worktreePath: string,
    opts: {
      title: string;
      body: string;
      base: string;
      head: string;
    },
  ) {
    const out = await this.gh(worktreePath, [
      'pr',
      'create',
      '--title',
      opts.title,
      '--body',
      opts.body,
      '--base',
      opts.base,
      '--head',
      opts.head,
    ]);

    return out.stdout.trim();
  }

  async getPullRequestChecks(worktreePath: string, prUrlOrNumber: string): Promise<PullRequestCheckState> {
    const out = await this.gh(worktreePath, ['pr', 'view', prUrlOrNumber, '--json', 'url,statusCheckRollup']);
    return this.parsePullRequestChecks(out.stdout);
  }

  async waitForPullRequestChecks(
    worktreePath: string,
    prUrlOrNumber: string,
    options: {
      timeoutMs: number;
      pollMs: number;
    },
  ): Promise<PullRequestCheckState> {
    const startedAt = Date.now();
    let latest: PullRequestCheckState = {
      summary: 'no checks reported',
      passed: true,
      pending: false,
      total: 0,
      failed: [],
    };

    while (Date.now() - startedAt <= options.timeoutMs) {
      latest = await this.getPullRequestChecks(worktreePath, prUrlOrNumber);
      if (!latest.pending) {
        return latest;
      }
      await new Promise((resolve) => setTimeout(resolve, options.pollMs));
    }

    return {
      ...latest,
      passed: false,
      pending: true,
      summary: latest.summary ? `${latest.summary}, timeout` : 'timeout waiting for checks',
    };
  }

  parsePullRequestChecks(raw: string): PullRequestCheckState {
    try {
      const parsed = JSON.parse(raw) as PullRequestView;
      const checks = parsed.statusCheckRollup || [];
      if (!checks.length) {
        return {
          summary: 'no checks reported',
          passed: true,
          pending: false,
          total: 0,
          failed: [],
        };
      }

      const failed: string[] = [];
      let pending = false;
      const summary = checks.map((check) => {
        const state = (check.conclusion || check.status || 'unknown').toLowerCase();
        if (['queued', 'pending', 'in_progress', 'waiting', 'requested', 'expected'].includes(state)) {
          pending = true;
        }
        if (['failure', 'failed', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(state)) {
          failed.push(check.name || 'check');
        }
        return `${check.name || 'check'}:${state}`;
      });

      return {
        summary: summary.join(', ') || 'no checks reported',
        passed: failed.length === 0 && !pending,
        pending,
        total: checks.length,
        failed,
      };
    } catch {
      const summary = raw.trim() || 'check data unavailable';
      return {
        summary,
        passed: false,
        pending: false,
        total: 0,
        failed: ['parse_error'],
      };
    }
  }

  protected async git(cwd: string, args: string[]) {
    return execFileAsync('git', args, {
      cwd,
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
  }

  protected async gh(cwd: string, args: string[]) {
    return execFileAsync('gh', args, {
      cwd,
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
  }
}
