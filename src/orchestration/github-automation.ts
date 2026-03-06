import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface PullRequestCheckRecord {
  conclusion?: string;
  status?: string;
  name?: string;
}

interface PullRequestActor {
  login?: string;
}

interface PullRequestCommentRecord {
  body?: string;
  url?: string;
  createdAt?: string;
  author?: PullRequestActor;
}

interface PullRequestReviewRecord {
  state?: string;
  body?: string;
  submittedAt?: string;
  author?: PullRequestActor;
}

interface PullRequestView {
  url?: string;
  headRefName?: string;
  statusCheckRollup?: PullRequestCheckRecord[];
  body?: string;
  reviewDecision?: string;
  comments?: PullRequestCommentRecord[];
  reviews?: PullRequestReviewRecord[];
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

export interface PullRequestReviewSummary {
  summary: string;
  decision: string;
  totalComments: number;
  totalReviews: number;
  changeRequests: number;
}

export interface PullRequestContext {
  url?: string;
  headRefName?: string;
  checks: PullRequestCheckState;
  previewUrls: string[];
  review: PullRequestReviewSummary;
}

const PREVIEW_HOST_TOKENS = ['vercel.app', 'netlify.app', 'pages.dev', 'onrender.com', 'render.com', 'fly.dev', 'ngrok', 'loca.lt'];

const extractUrls = (value: string) => value.match(/https?:\/\/[^\s<>"')\]]+/g) || [];

const likelyPreviewUrl = (url: string, contextText: string) => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.githubusercontent.com')) {
      return false;
    }
    if (PREVIEW_HOST_TOKENS.some((token) => host.includes(token))) {
      return true;
    }
    if (host.includes('preview') || host.includes('staging') || host.includes('sandbox')) {
      return true;
    }
    return /\bpreview\b|\bstaging\b|\bdeploy(?:ment)?\b|\bdemo\b/i.test(contextText);
  } catch {
    return false;
  }
};

const summarizeText = (value: string) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117).trimEnd()}...`;
};

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

  async getPullRequestContext(worktreePath: string, prUrlOrNumber: string): Promise<PullRequestContext> {
    const out = await this.gh(worktreePath, [
      'pr',
      'view',
      prUrlOrNumber,
      '--json',
      'url,headRefName,body,reviewDecision,comments,reviews,statusCheckRollup',
    ]);
    return this.parsePullRequestContext(out.stdout);
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

  parsePullRequestContext(raw: string): PullRequestContext {
    try {
      const parsed = JSON.parse(raw) as PullRequestView;
      const body = typeof parsed.body === 'string' ? parsed.body : '';
      const comments = Array.isArray(parsed.comments) ? parsed.comments : [];
      const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
      const previewUrls = new Set<string>();

      for (const source of [body, ...comments.map((comment) => comment.body || ''), ...reviews.map((review) => review.body || '')]) {
        for (const url of extractUrls(source)) {
          if (likelyPreviewUrl(url, source)) {
            previewUrls.add(url);
          }
        }
      }

      const reviewStates = reviews.map((review) => (typeof review.state === 'string' ? review.state.toUpperCase() : ''));
      const explicitDecision = typeof parsed.reviewDecision === 'string' ? parsed.reviewDecision.toLowerCase() : '';
      const changeRequests = reviewStates.filter((state) => state === 'CHANGES_REQUESTED').length;
      const decision =
        explicitDecision ||
        (changeRequests > 0
          ? 'changes_requested'
          : reviewStates.includes('APPROVED')
            ? 'approved'
            : reviews.length > 0 || comments.length > 0
              ? 'reviewed'
              : 'none');

      const highlights = [
        ...comments
          .map((comment) => {
            const snippet = summarizeText(comment.body || '');
            if (!snippet) return '';
            return `${comment.author?.login || 'comment'}: ${snippet}`;
          })
          .filter(Boolean),
        ...reviews
          .map((review) => {
            const snippet = summarizeText(review.body || '');
            if (!snippet) return '';
            return `${(review.state || 'review').toLowerCase()} by ${review.author?.login || 'reviewer'}: ${snippet}`;
          })
          .filter(Boolean),
      ].slice(0, 2);

      const reviewSummaryParts = [
        `decision=${decision}`,
        `reviews=${reviews.length}`,
        `comments=${comments.length}`,
      ];
      if (changeRequests > 0) {
        reviewSummaryParts.push(`changeRequests=${changeRequests}`);
      }
      if (highlights.length > 0) {
        reviewSummaryParts.push(`highlights=${highlights.join(' | ')}`);
      }

      return {
        url: typeof parsed.url === 'string' ? parsed.url : undefined,
        headRefName: typeof parsed.headRefName === 'string' ? parsed.headRefName : undefined,
        checks: this.parsePullRequestChecks(raw),
        previewUrls: Array.from(previewUrls),
        review: {
          summary: reviewSummaryParts.join(', '),
          decision,
          totalComments: comments.length,
          totalReviews: reviews.length,
          changeRequests,
        },
      };
    } catch {
      return {
        checks: this.parsePullRequestChecks(raw),
        previewUrls: [],
        review: {
          summary: 'review context unavailable',
          decision: 'unknown',
          totalComments: 0,
          totalReviews: 0,
          changeRequests: 0,
        },
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
