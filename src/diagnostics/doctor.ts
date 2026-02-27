import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config.js';
import { formatStartupIssue, validateStartupConfig, type StartupIssue } from '../utils/startup.js';

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

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--strict') {
      parsed.strict = true;
      continue;
    }
    if (arg === '--runtime-url') {
      parsed.runtimeUrl = args[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--runtime-token') {
      parsed.runtimeToken = args[index + 1] || '';
      index += 1;
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

const buildIssue = (
  issues: StartupIssue[],
  severity: 'warn' | 'error',
  area: string,
  message: string,
  remediation?: string,
  code?: string,
) => {
  issues.push({ severity, area, message, remediation, code });
};

const buildRunChecks = (issues: StartupIssue[]) => {
  if (!fs.existsSync(path.join(process.cwd(), 'dist', 'index.js'))) {
    buildIssue(
      issues,
      'error',
      'runtime',
      'dist/index.js is missing; runtime is not built.',
      'Run npm run build, then retry talonbot start or systemctl restart talonbot.service.',
      'runtime_dist_missing',
    );
  }

  if (!process.env.HOME) {
    buildIssue(
      issues,
      'error',
      'runtime',
      'HOME is not set.',
      'Set HOME for the service user in the environment and restart the process.',
      'runtime_home_missing',
    );
  }

  const dataDir = config.DATA_DIR.replace('~', process.env.HOME || '');
  const socketPath = config.CONTROL_SOCKET_PATH.replace('~', process.env.HOME || '');
  const socketDir = path.dirname(socketPath);

  if (!fs.existsSync(dataDir)) {
    buildIssue(
      issues,
      'warn',
      'storage',
      `DATA_DIR ${dataDir} does not exist yet.`,
      'Create it now to avoid startup-time permission surprises: mkdir -p "<DATA_DIR>"',
      'storage_data_dir_missing',
    );
  }

  if (!fs.existsSync(socketDir)) {
    buildIssue(
      issues,
      'warn',
      'socket',
      `CONTROL_SOCKET_PATH directory ${socketDir} does not exist yet.`,
      'Create the parent directory or set CONTROL_SOCKET_PATH to a writable directory.',
      'socket_dir_missing',
    );
  }

  if (!fs.existsSync('/tmp')) {
    buildIssue(
      issues,
      'warn',
      'runtime',
      '/tmp is not available for temporary runtime checks.',
      'Ensure /tmp exists and is writable, or use an alternate tmp mount before starting service checks.',
      'runtime_tmp_missing',
    );
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
      buildIssue(
        issues,
        'error',
        'runtime',
        `Health check failed with status ${health.status}.`,
        'Confirm talonbot is running, verify CONTROL_HTTP_PORT, and retry with --runtime-url pointing to the correct host:port.',
        'runtime_health_status_failed',
      );
      return;
    }

    const payload = (await parseJsonBody(health)) as { status?: string };
    if (payload.status !== 'ok') {
      buildIssue(
        issues,
        'error',
        'runtime',
        `Health status not ok: ${JSON.stringify(payload)}.`,
        'Inspect logs (`talonbot logs` or journalctl -u talonbot.service -f) and resolve dependency errors before deploy.',
        'runtime_health_payload_not_ok',
      );
    }
  } catch (error) {
    buildIssue(
      issues,
      'error',
      'runtime',
      `Health endpoint not reachable at ${url}: ${(error as Error).message}`,
      'Start or restart talonbot, then retry doctor with the correct --runtime-url.',
      'runtime_health_unreachable',
    );
  }

  try {
    const sessions = await fetch(`${url.replace(/\/$/, '')}/sessions`, { headers });
    if (!token && sessions.status === 401) {
      buildIssue(
        issues,
        'warn',
        'runtime',
        'Runtime auth is enabled and no token was provided for /sessions probe.',
        'Pass --runtime-token <token> or set CONTROL_AUTH_TOKEN in environment before running doctor runtime checks.',
        'runtime_auth_token_missing_for_probe',
      );
      return;
    }
    if (token && !sessions.ok && sessions.status !== 401) {
      buildIssue(
        issues,
        'warn',
        'runtime',
        `Authenticated /sessions check returned status ${sessions.status}.`,
        'Verify CONTROL_AUTH_TOKEN matches the running service and retry.',
        'runtime_sessions_status_unexpected',
      );
      return;
    }
    if (token && sessions.status === 200) {
      await parseJsonBody(sessions);
    }
  } catch (error) {
    buildIssue(
      issues,
      'warn',
      'runtime',
      `Runtime sessions endpoint check failed: ${(error as Error).message}`,
      'Check network/firewall to localhost control port and retry.',
      'runtime_sessions_probe_failed',
    );
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
    process.stdout.write(`${tag} [${issue.area}] ${formatStartupIssue(issue)}\n`);
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
