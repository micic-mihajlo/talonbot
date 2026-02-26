import { describe, expect, it } from 'vitest';
import { GitHubAutomation, type PullRequestCheckState } from '../src/orchestration/github-automation.js';

class FakeGitHubAutomation extends GitHubAutomation {
  private index = 0;

  constructor(private readonly states: PullRequestCheckState[]) {
    super();
  }

  override async getPullRequestChecks(): Promise<PullRequestCheckState> {
    const current = this.states[Math.min(this.index, this.states.length - 1)];
    this.index += 1;
    return current;
  }
}

describe('github automation checks parser', () => {
  it('parses pending and failed checks from pull request json', () => {
    const automation = new GitHubAutomation();
    const parsed = automation.parsePullRequestChecks(
      JSON.stringify({
        statusCheckRollup: [
          { name: 'build', conclusion: 'SUCCESS' },
          { name: 'lint', status: 'IN_PROGRESS' },
          { name: 'test', conclusion: 'FAILURE' },
        ],
      }),
    );

    expect(parsed.pending).toBe(true);
    expect(parsed.passed).toBe(false);
    expect(parsed.total).toBe(3);
    expect(parsed.failed).toContain('test');
    expect(parsed.summary).toContain('build:success');
    expect(parsed.summary).toContain('lint:in_progress');
    expect(parsed.summary).toContain('test:failure');
  });

  it('treats empty check rollup as pass', () => {
    const automation = new GitHubAutomation();
    const parsed = automation.parsePullRequestChecks(JSON.stringify({ statusCheckRollup: [] }));

    expect(parsed.passed).toBe(true);
    expect(parsed.pending).toBe(false);
    expect(parsed.total).toBe(0);
  });
});

describe('github automation check polling', () => {
  it('waits until pending checks settle', async () => {
    const automation = new FakeGitHubAutomation([
      {
        summary: 'build:in_progress',
        passed: false,
        pending: true,
        total: 1,
        failed: [],
      },
      {
        summary: 'build:success',
        passed: true,
        pending: false,
        total: 1,
        failed: [],
      },
    ]);

    const finalState = await automation.waitForPullRequestChecks('/tmp', '1', {
      timeoutMs: 1000,
      pollMs: 1,
    });

    expect(finalState.passed).toBe(true);
    expect(finalState.pending).toBe(false);
    expect(finalState.summary).toContain('build:success');
  });

  it('returns timeout result when checks do not settle', async () => {
    const automation = new FakeGitHubAutomation([
      {
        summary: 'build:in_progress',
        passed: false,
        pending: true,
        total: 1,
        failed: [],
      },
    ]);

    const finalState = await automation.waitForPullRequestChecks('/tmp', '1', {
      timeoutMs: 10,
      pollMs: 1,
    });

    expect(finalState.passed).toBe(false);
    expect(finalState.pending).toBe(true);
    expect(finalState.summary).toContain('timeout');
  });
});
