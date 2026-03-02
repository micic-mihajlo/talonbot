import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/gi;

export const verifyGitHubPullRequestUrl = async (url: string, timeoutMs = 10000): Promise<boolean> => {
  try {
    await execFileAsync('gh', ['pr', 'view', url, '--json', 'url'], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
};

export const hasVerifiedGitHubPrUrl = async (text: string): Promise<boolean> => {
  const matches = text.match(GITHUB_PR_URL_RE) || [];
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
