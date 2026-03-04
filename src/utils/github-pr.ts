import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/gi;

const extractTaskToken = (branch: string) => {
  const match = branch.match(/task-\d+-[a-f0-9]+/i);
  return match?.[0]?.toLowerCase() || '';
};

const headBranchMatches = (actualHead: string, expectedHead: string) => {
  const actual = actualHead.trim();
  const expected = expectedHead.trim();
  if (!actual || !expected) {
    return false;
  }

  if (actual === expected) {
    return true;
  }

  if (actual.startsWith(`${expected}-`)) {
    return true;
  }

  const expectedTaskToken = extractTaskToken(expected);
  if (expectedTaskToken && actual.toLowerCase().includes(expectedTaskToken)) {
    return true;
  }

  return false;
};

export const extractGitHubPullRequestUrls = (text: string): string[] => {
  if (!text) return [];
  const matches = text.match(GITHUB_PR_URL_RE) || [];
  return Array.from(new Set(matches));
};

export const verifyGitHubPullRequestUrl = async (
  url: string,
  timeoutMs = 10000,
  expectedHeadRefName?: string,
  expectedRepoFullName?: string,
): Promise<boolean> => {
  try {
    if (expectedRepoFullName?.trim()) {
      const match = url.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/i);
      const repoFromUrl = match ? `${match[1]}/${match[2]}`.toLowerCase() : '';
      if (!repoFromUrl || repoFromUrl !== expectedRepoFullName.trim().toLowerCase()) {
        return false;
      }
    }

    const { stdout } = await execFileAsync('gh', ['pr', 'view', url, '--json', 'url,headRefName'], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });

    if (!expectedHeadRefName?.trim()) {
      return true;
    }

    const parsed = JSON.parse(stdout || '{}') as { headRefName?: string };
    const headRefName = typeof parsed.headRefName === 'string' ? parsed.headRefName : '';
    return headBranchMatches(headRefName, expectedHeadRefName);
  } catch {
    return false;
  }
};

export const hasVerifiedGitHubPrUrl = async (text: string): Promise<boolean> => {
  const matches = extractGitHubPullRequestUrls(text);
  if (matches.length === 0) {
    return false;
  }

  for (const url of new Set(matches)) {
    if (await verifyGitHubPullRequestUrl(url)) {
      return true;
    }
  }

  return false;
};
