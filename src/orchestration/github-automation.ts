import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitHubAutomation {
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

  async getPullRequestChecks(worktreePath: string, prUrlOrNumber: string) {
    const out = await this.gh(worktreePath, ['pr', 'view', prUrlOrNumber, '--json', 'url,statusCheckRollup']);
    try {
      const parsed = JSON.parse(out.stdout) as {
        url?: string;
        statusCheckRollup?: Array<{ conclusion?: string; status?: string; name?: string }>;
      };

      const checks = (parsed.statusCheckRollup || []).map((check) => {
        const state = check.conclusion || check.status || 'unknown';
        return `${check.name || 'check'}:${state}`;
      });

      return checks.length ? checks.join(', ') : 'no checks reported';
    } catch {
      return out.stdout.trim() || 'check data unavailable';
    }
  }

  private async git(cwd: string, args: string[]) {
    return execFileAsync('git', args, {
      cwd,
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
  }

  private async gh(cwd: string, args: string[]) {
    return execFileAsync('gh', args, {
      cwd,
      timeout: 120000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    });
  }
}
