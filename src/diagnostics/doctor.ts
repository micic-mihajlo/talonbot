import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { config } from '../config.js';
import { validateStartupConfig, type StartupIssue } from '../utils/startup.js';

type DoctorArgName = '--json' | '--strict' | '--runtime-url' | '--runtime-token';
type DoctorArgs = {
  json: boolean;
  strict: boolean;
  runtimeUrl?: string;
  runtimeToken?: string;
};

const parseArgs = (): DoctorArgs => {
  const args: string[] = process.argv.slice(2);
  const parsed: DoctorArgs = {
    json: false,
    strict: false,
  };

  for (const arg of args) {
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--strict') {
      parsed.strict = true;
      continue;
    }
    if (arg.startsWith('--runtime-url=')) {
      parsed.runtimeUrl = arg.replace('--runtime-url=', '');
      continue;
    }
    if (arg.startsWith('--runtime-token=')) {
      parsed.runtimeToken = arg.replace('--runtime-token=', '');
    }
  }

  return parsed;
};

const commandExists = (command: string): boolean => {
  if (!command.trim()) {
    return false;
  }

  if (command.includes('/')) {
    return fs.existsSync(command);
  }

  try {
    execFileSync('sh', ['-lc', `command -v ${JSON.stringify(command)}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const buildIssue = (issues: StartupIssue[], severity: 'warn' | 'error', area: string, message: string) => {
  issues.push({ severity, area, message });
};

const buildRunChecks = (issues: StartupIssue[]) => {
  if (!fs.existsSync(path.join(process.cwd(), 'dist', 'index.js'))) {
    buildIssue(issues, 'error', 'runtime', 'dist/index.js is missing; run npm run build before start.');
  }

  if (!process.env.HOME) {
    buildIssue(issues, 'error', 'runtime', 'HOME is not set.');
  }

  if (config.ENGINE_MODE === 'process' && !commandExists(config.ENGINE_COMMAND)) {
    buildIssue(
      issues,
      'error',
      'engine',
      `ENGINE_COMMAND "${config.ENGINE_COMMAND}" is not executable or not on PATH.`,
    );
  }

  if (config.SLACK_ENABLED) {
    if (!config.SLACK_BOT_TOKEN || !config.SLACK_APP_TOKEN || !config.SLACK_SIGNING_SECRET) {
      buildIssue(
        issues,
        'error',
        'transport',
        'SLACK_ENABLED=true requires SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET.',
      );
    }
  }

  if (config.DISCORD_ENABLED && !config.DISCORD_TOKEN) {
    buildIssue(issues, 'error', 'transport', 'DISCORD_ENABLED=true requires DISCORD_TOKEN.');
  }

  const dataDir = config.DATA_DIR.replace('~', process.env.HOME || '');
  const socketPath = config.CONTROL_SOCKET_PATH.replace('~', process.env.HOME || '');
  const socketDir = path.dirname(socketPath);

  if (!fs.existsSync(dataDir)) {
    buildIssue(issues, 'warn', 'storage', `DATA_DIR ${dataDir} does not exist (it will be created by startup checks).`);
  }

  if (!fs.existsSync(socketDir)) {
    buildIssue(issues, 'warn', 'socket', `CONTROL_SOCKET_PATH directory ${socketDir} does not exist yet.`);
  }

  if (!fs.existsSync('/tmp')) {
    buildIssue(issues, 'warn', 'runtime', '/tmp is not available for temporary socket smoke paths.');
  }
};

const parseJsonBody = async (res: Response) => {
  const body = await res.text();
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return { raw: body };
  }
};

const checkRuntime = async (url: string, issues: StartupIssue[], token?: string) => {
  const headers: Record<string, string> = {
    'accept': 'application/json',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const health = await fetch(`${url.replace(/\/$/, '')}/health`, { headers });
    if (!health.ok) {
      buildIssue(issues, 'error', 'runtime', `Health check failed with status ${health.status}.`);
      return;
    }

    const payload = (await parseJsonBody(health)) as { status?: string };
    if (payload.status !== 'ok') {
      buildIssue(issues, 'error', 'runtime', `Health status not ok: ${JSON.stringify(payload)}.`);
    }
  } catch (error) {
    buildIssue(issues, 'error', 'runtime', `Health endpoint not reachable at ${url}: ${(error as Error).message}`);
  }

  try {
    const sessions = await fetch(`${url.replace(/\/$/, '')}/sessions`, { headers });
    if (!token && sessions.status === 401) {
      // expected when tokenless auth is enforced
      return;
    }
    if (token && !sessions.ok && sessions.status !== 401) {
      buildIssue(issues, 'warn', 'runtime', `Authenticated /sessions check returned status ${sessions.status}.`);
      return;
    }
    if (token && sessions.status === 200) {
      await parseJsonBody(sessions);
    }
  } catch (error) {
    buildIssue(issues, 'warn', 'runtime', `Runtime sessions endpoint check failed: ${(error as Error).message}`);
  }
};

export const gatherDoctorIssues = async (args: DoctorArgs = parseArgs()): Promise<StartupIssue[]> => {
  const issues: StartupIssue[] = validateStartupConfig(config);
  buildRunChecks(issues);

  if (args.runtimeUrl) {
    const token = args.runtimeToken || config.CONTROL_AUTH_TOKEN;
    await checkRuntime(args.runtimeUrl, issues, token);
  }

  return issues;
};

const printText = (issues: StartupIssue[]) => {
  if (!issues.length) {
    process.stdout.write('doctor: ok (no issues)\n');
    return;
  }

  for (const issue of issues) {
    const tag = issue.severity === 'error' ? '[ERROR]' : '[WARN]';
    process.stdout.write(`${tag} [${issue.area}] ${issue.message}\n`);
  }
};

const run = async () => {
  const args = parseArgs();
  const issues = await gatherDoctorIssues(args);
  const hasError = issues.some((issue) => issue.severity === 'error');
  const hasWarning = issues.some((issue) => issue.severity === 'warn');
  const shouldFail = hasError || (args.strict && hasWarning);

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          status: shouldFail ? 'failed' : 'passed',
          issues,
          metrics: {
            errors: issues.filter((issue) => issue.severity === 'error').length,
            warnings: issues.filter((issue) => issue.severity === 'warn').length,
            strict: args.strict,
            runtimeChecked: !!args.runtimeUrl,
          },
        },
        null,
        2,
      ),
    );
    process.stdout.write('\n');
  } else {
    printText(issues);
    process.stdout.write(
      `doctor: ${shouldFail ? 'failed' : 'passed'} (${issues.filter((issue) => issue.severity === 'error').length} errors, ${issues.filter((issue) => issue.severity === 'warn').length} warnings)\n`,
    );
  }

  if (shouldFail) {
    process.exit(1);
  }
};

run().catch((error) => {
  process.stdout.write(`doctor: unexpected failure ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
