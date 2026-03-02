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
  headRefName?: string;
  statusCheckRollup?: PullRequestCheckRecord[];
}

export interface PullRequestCheckState {
  summary: string;
  passed: boolean;
  pending: boolean;
  total: number;
  failed: string[];
}

export interface PullRequestMatch {
  url: string;
  headRefName: string;
}

const extractTaskToken = (value: string) => {
  const match = value.match(/task-\d+-[a-f0-9]+/i);
  return match?.[0]?.toLowerCase() || '';
};

const headRefMatches = (actual: string, expected: string, taskId?: string) => {
  const normalizedActual = actual.trim();
  const normalizedExpected = expected.trim();
  if (!normalizedActual) {
    return false;
  }

  if (normalizedExpected) {
    if (normalizedActual === normalizedExpected) {
      return true;
    }
    if (normalizedActual.startsWith(`${normalizedExpected}-`)) {
      return true;
    }

    const expectedToken = extractTaskToken(normalizedExpected);
    if (expectedToken && normalizedActual.toLowerCase().includes(expectedToken)) {
      return true;
    }
  }

  if (taskId && normalizedActual.toLowerCase().includes(taskId.toLowerCase())) {
    return true;
  }

  return false;
};

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

  async findPullRequestByBranch(
    worktreePath: string,
    options: {
      expectedHeadRefName?: string;
      taskId?: string;
      limit?: number;
    },
  ): Promise<PullRequestMatch | null> {
    const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(500, options.limit || 200)) : 200;
    const out = await this.gh(worktreePath, ['pr', 'list', '--state', 'all', '--limit', String(limit), '--json', 'url,headRefName']);
    const parsed = JSON.parse(out.stdout || '[]') as Array<PullRequestView>;
    for (const candidate of parsed) {
      const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
      const headRefName = typeof candidate.headRefName === 'string' ? candidate.headRefName.trim() : '';
      if (!url || !headRefName) continue;
      if (!headRefMatches(headRefName, options.expectedHeadRefName || '', options.taskId)) continue;
      return { url, headRefName };
    }
    return null;
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
