#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { config } from '../config.js';

const baseUrl = `http://127.0.0.1:${config.CONTROL_HTTP_PORT || 8080}`;

class CliError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.hint = hint;
  }
}

class HttpError extends CliError {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, route: string, payload: unknown, hint?: string) {
    super(`HTTP ${status} ${route}: ${JSON.stringify(payload)}`, hint);
    this.name = 'HttpError';
    this.status = status;
    this.payload = payload;
  }
}

const fail = (message: string, hint?: string): never => {
  throw new CliError(message, hint);
};

const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

const parseArgs = (argv: string[]) => {
  const args = argv.slice(2);
  const command = args[0] || 'help';
  return { command, args: args.slice(1) };
};

const getFlag = (args: string[], name: string, fallback = '') => {
  const prefixed = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefixed));
  if (direct) return direct.slice(prefixed.length);

  const index = args.findIndex((arg) => arg === `--${name}`);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }

  return fallback;
};

const hasFlag = (args: string[], name: string) => args.includes(name);

const httpHint = (status: number) => {
  if (status === 401) {
    return 'CONTROL_AUTH_TOKEN does not match the running service. Update .env and retry `talonbot env get CONTROL_AUTH_TOKEN`.';
  }
  if (status === 404) {
    return 'API route was not found. Confirm the runtime version with `talonbot operator --json`.';
  }
  if (status >= 500) {
    return 'Runtime reported an internal error. Inspect logs with `talonbot logs` or `journalctl -u talonbot.service -f`.';
  }
  return undefined;
};

const request = async (method: 'GET' | 'POST', route: string, body?: unknown) => {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };

  if (config.CONTROL_AUTH_TOKEN) {
    headers.authorization = `Bearer ${config.CONTROL_AUTH_TOKEN}`;
  }

  if (body) {
    headers['content-type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw new CliError(
      `unable to reach control API at ${baseUrl}: ${(error as Error).message}`,
      'Start or restart talonbot (`talonbot start` / `talonbot restart`) and verify CONTROL_HTTP_PORT.',
    );
  }

  const raw = await res.text();
  let payload: unknown;
  try {
    payload = raw ? (JSON.parse(raw) as unknown) : {};
  } catch {
    payload = { raw };
  }

  if (!res.ok) {
    throw new HttpError(res.status, route, payload, httpHint(res.status));
  }
  return payload;
};

const runSystemctl = (action: 'start' | 'stop' | 'restart' | 'status' | 'logs') => {
  const cmd = action === 'logs' ? ['journalctl', '-u', 'talonbot.service', '-f'] : ['systemctl', action, 'talonbot.service'];
  execFileSync(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
  });
};

const runNpm = (script: string, extraArgs: string[] = []) => {
  execFileSync('npm', ['run', script, '--', ...extraArgs], {
    stdio: 'inherit',
  });
};

const runRepoScript = (scriptPath: string, extraArgs: string[] = [], extraEnv: Record<string, string> = {}) => {
  const absolute = path.join(process.cwd(), scriptPath);
  execFileSync(absolute, extraArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
};

const envFilePath = () => process.env.TALONBOT_ENV_FILE || path.join(process.cwd(), '.env');

const parseEnv = (raw: string) => {
  const lines = raw.split(/\r?\n/);
  const map = new Map<string, string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    map.set(key, value);
  }

  return map;
};

const formatEnv = (values: Map<string, string>) => {
  return `${Array.from(values.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
};

const readEnvMap = async () => {
  const file = envFilePath();
  const raw = await fs.readFile(file, { encoding: 'utf8' }).catch(() => '');
  return parseEnv(raw);
};

const writeEnvMap = async (values: Map<string, string>) => {
  const file = envFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, formatEnv(values), { encoding: 'utf8' });
};

const attachToSession = async (sessionKey: string) => {
  const socketPath = config.CONTROL_SOCKET_PATH.replace('~', process.env.HOME || '');

  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.setEncoding('utf8');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const send = (line: string) => {
      const text = line.trim();
      if (!text) return;
      if (text === '.exit' || text === '.quit') {
        rl.close();
        socket.end();
        resolve();
        return;
      }

      socket.write(
        `${JSON.stringify({
          type: 'send',
          sessionKey,
          message: text,
          id: `attach-${Date.now()}`,
        })}\n`,
      );

      socket.write(
        `${JSON.stringify({
          type: 'get_message',
          sessionKey,
          id: `attach-get-${Date.now()}`,
        })}\n`,
      );
    };

    process.stdout.write(`attached to ${sessionKey} (type .exit to quit)\n`);
    rl.on('line', send);

    socket.on('data', (chunk) => {
      const payload = String(chunk)
        .split('\n')
        .filter(Boolean);
      for (const line of payload) {
        try {
          const parsed = JSON.parse(line) as { data?: { message?: { content?: string } }; error?: string };
          if (parsed.error) {
            process.stdout.write(`error: ${parsed.error}\n`);
            continue;
          }

          const content = parsed.data?.message?.content;
          if (content) {
            process.stdout.write(`assistant: ${content}\n`);
          }
        } catch {
          process.stdout.write(`${line}\n`);
        }
      }
    });

    socket.on('error', (error) => {
      rl.close();
      reject(error);
    });

    socket.on('close', () => {
      rl.close();
      resolve();
    });
  });
};

type ProbeResult = {
  ok: boolean;
  payload?: unknown;
  error?: string;
  hint?: string;
};

const probeRoute = async (route: string): Promise<ProbeResult> => {
  try {
    return {
      ok: true,
      payload: await request('GET', route),
    };
  } catch (error) {
    if (error instanceof HttpError && error.status === 501) {
      return {
        ok: false,
        error: 'not_configured',
      };
    }

    const cliError = error as CliError;
    return {
      ok: false,
      error: cliError.message,
      hint: cliError.hint,
    };
  }
};

const runOperatorSummary = async (asJson: boolean) => {
  const [health, status, release, sentry] = await Promise.all([
    probeRoute('/health'),
    probeRoute('/status'),
    probeRoute('/release/status'),
    probeRoute('/sentry/status'),
  ]);

  const summary = {
    generatedAt: new Date().toISOString(),
    controlApi: baseUrl,
    health,
    status,
    release,
    sentry,
  };

  if (asJson) {
    json(summary);
    return;
  }

  process.stdout.write(`operator summary\n`);
  process.stdout.write(`control api: ${baseUrl}\n`);

  if (health.ok) {
    const payload = health.payload as { status?: string; uptime?: number; sessions?: number };
    process.stdout.write(`health: ${payload.status || 'ok'} (uptime=${Math.round(payload.uptime || 0)}s, sessions=${payload.sessions || 0})\n`);
  } else {
    process.stdout.write(`health: unavailable (${health.error})\n`);
    if (health.hint) process.stdout.write(`next: ${health.hint}\n`);
  }

  if (status.ok) {
    const payload = status.payload as { process?: { pid?: number; node?: string }; config?: { engineMode?: string } };
    process.stdout.write(`runtime: pid=${payload.process?.pid || 'n/a'} node=${payload.process?.node || 'n/a'} engine=${payload.config?.engineMode || 'n/a'}\n`);
  } else {
    process.stdout.write(`runtime: unavailable (${status.error})\n`);
    if (status.hint) process.stdout.write(`next: ${status.hint}\n`);
  }

  if (release.ok) {
    const payload = release.payload as { release?: { current?: string | null; previous?: string | null } };
    process.stdout.write(`release: current=${payload.release?.current || 'none'} previous=${payload.release?.previous || 'none'}\n`);
  } else if (release.error === 'not_configured') {
    process.stdout.write('release: not configured\n');
  } else {
    process.stdout.write(`release: unavailable (${release.error})\n`);
    if (release.hint) process.stdout.write(`next: ${release.hint}\n`);
  }

  if (sentry.ok) {
    const payload = sentry.payload as { status?: { incidents?: number } };
    process.stdout.write(`sentry: incidents=${payload.status?.incidents ?? 0}\n`);
  } else if (sentry.error === 'not_configured') {
    process.stdout.write('sentry: not configured\n');
  } else {
    process.stdout.write(`sentry: unavailable (${sentry.error})\n`);
    if (sentry.hint) process.stdout.write(`next: ${sentry.hint}\n`);
  }

  process.stdout.write('next: run `talonbot doctor -- --strict --runtime-url http://127.0.0.1:8080` before deploy/rollback.\n');
};

const help = () => {
  process.stdout.write('talonbot CLI\n\n');
  process.stdout.write('Commands:\n');
  process.stdout.write('  start|stop|restart|status|logs\n');
  process.stdout.write('  status [--api|--service|--json]\n');
  process.stdout.write('  operator [summary|status] [--json]\n');
  process.stdout.write('  sessions|attach --session <sessionKey>\n');
  process.stdout.write('  doctor\n');
  process.stdout.write('  env get|set|list|sync\n');
  process.stdout.write('  tasks list|get|create|retry|cancel\n');
  process.stdout.write('  repos list|register|remove\n');
  process.stdout.write('  deploy|update [--source <path>]\n');
  process.stdout.write('  rollback [target]\n');
  process.stdout.write('  sentry [status]\n');
  process.stdout.write('  audit [--deep]|prune [days]|firewall [--dry-run]\n');
  process.stdout.write('  bundle [--output <path>]\n');
  process.stdout.write('  uninstall --force [--purge]\n\n');
  process.stdout.write('Examples:\n');
  process.stdout.write('  talonbot status --api\n');
  process.stdout.write('  talonbot operator --json\n');
  process.stdout.write('  talonbot deploy --source /path/to/talonbot\n');
};

const main = async () => {
  const { command, args } = parseArgs(process.argv);

  if (['start', 'stop', 'restart', 'logs'].includes(command)) {
    runSystemctl(command as 'start' | 'stop' | 'restart' | 'logs');
    return;
  }

  if (command === 'status') {
    const apiOnly = hasFlag(args, '--api') || hasFlag(args, '--json');
    const serviceOnly = hasFlag(args, '--service');
    if (apiOnly && serviceOnly) {
      fail('status flags --api/--json and --service are mutually exclusive.');
    }

    if (apiOnly) {
      json(await request('GET', '/status'));
      return;
    }

    if (serviceOnly) {
      runSystemctl('status');
      return;
    }

    try {
      runSystemctl('status');
      return;
    } catch {
      json(await request('GET', '/status'));
      return;
    }
  }

  if (command === 'operator') {
    const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'summary';
    if (mode !== 'summary' && mode !== 'status') {
      fail(`unknown operator command: ${mode}`, 'Use `talonbot operator summary` or `talonbot operator --json`.');
    }

    await runOperatorSummary(hasFlag(args, '--json'));
    return;
  }

  if (command === 'sessions') {
    json(await request('GET', '/sessions'));
    return;
  }

  if (command === 'attach') {
    const session = getFlag(args, 'session') || args[0];
    if (!session) {
      fail('attach requires --session <sessionKey>', 'Example: talonbot attach --session discord:12345:main');
    }
    await attachToSession(session);
    return;
  }

  if (command === 'doctor') {
    runNpm('doctor', args);
    return;
  }

  if (command === 'env') {
    const sub = args[0] || 'list';

    if (sub === 'list') {
      const values = await readEnvMap();
      json({
        file: envFilePath(),
        values: Object.fromEntries(values.entries()),
      });
      return;
    }

    if (sub === 'get') {
      const key = args[1];
      if (!key) fail('env get requires a key', 'Example: talonbot env get CONTROL_AUTH_TOKEN');
      const values = await readEnvMap();
      json({ key, value: values.get(key) || '' });
      return;
    }

    if (sub === 'set') {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) fail('env set requires key and value', 'Example: talonbot env set LOG_LEVEL debug');
      const values = await readEnvMap();
      values.set(key, value);
      await writeEnvMap(values);
      json({ key, value, file: envFilePath() });
      return;
    }

    if (sub === 'sync') {
      const values = await readEnvMap();
      await writeEnvMap(values);
      json({ synced: true, file: envFilePath() });
      return;
    }

    fail(`unknown env command: ${sub}`, 'Use: env get|set|list|sync');
  }

  if (command === 'tasks') {
    const sub = args[0] || 'list';

    if (sub === 'list') {
      const state = args[1] ? `?state=${encodeURIComponent(args[1])}` : '';
      json(await request('GET', `/tasks${state}`));
      return;
    }

    if (sub === 'get') {
      const id = args[1];
      if (!id) fail('task id required', 'Example: talonbot tasks get <task-id>');
      json(await request('GET', `/tasks/${encodeURIComponent(id)}`));
      return;
    }

    if (sub === 'create') {
      const repoId = getFlag(args, 'repo');
      const text = getFlag(args, 'text') || args.filter((arg) => !arg.startsWith('--') && arg !== 'create').join(' ');
      const fanoutArg = getFlag(args, 'fanout');
      const fanout = fanoutArg ? fanoutArg.split('|').map((item) => item.trim()).filter(Boolean) : undefined;
      if (!text.trim()) fail('task text required', 'Example: talonbot tasks create --repo my-repo --text "Fix flaky CI"');
      json(
        await request('POST', '/tasks', {
          repoId: repoId || undefined,
          text,
          fanout,
        }),
      );
      return;
    }

    if (sub === 'retry') {
      const id = args[1];
      if (!id) fail('task id required', 'Example: talonbot tasks retry <task-id>');
      json(await request('POST', `/tasks/${encodeURIComponent(id)}/retry`));
      return;
    }

    if (sub === 'cancel') {
      const id = args[1];
      if (!id) fail('task id required', 'Example: talonbot tasks cancel <task-id>');
      json(await request('POST', `/tasks/${encodeURIComponent(id)}/cancel`));
      return;
    }

    fail(`unknown tasks command: ${sub}`, 'Use: tasks list|get|create|retry|cancel');
  }

  if (command === 'repos') {
    const sub = args[0] || 'list';

    if (sub === 'list') {
      json(await request('GET', '/repos'));
      return;
    }

    if (sub === 'register') {
      const id = getFlag(args, 'id');
      const repoPath = getFlag(args, 'path');
      if (!id || !repoPath) {
        fail('repos register requires --id and --path', 'Example: talonbot repos register --id app --path ~/workspace/app --default true');
      }

      json(
        await request('POST', '/repos/register', {
          id,
          path: repoPath,
          defaultBranch: getFlag(args, 'branch') || 'main',
          remote: getFlag(args, 'remote') || 'origin',
          isDefault: getFlag(args, 'default', 'false') === 'true',
        }),
      );
      return;
    }

    if (sub === 'remove') {
      const id = args[1];
      if (!id) fail('repo id required', 'Example: talonbot repos remove <repo-id>');
      json(await request('POST', '/repos/remove', { id }));
      return;
    }

    fail(`unknown repos command: ${sub}`, 'Use: repos list|register|remove');
  }

  if (command === 'deploy' || command === 'update') {
    const sourceDir = path.resolve(getFlag(args, 'source') || process.cwd());
    const sourceStat = await fs.stat(sourceDir).catch(() => null);
    if (!sourceStat || !sourceStat.isDirectory()) {
      fail(`deploy source directory does not exist: ${sourceDir}`, 'Pass --source <path> to a valid talonbot repository root.');
    }

    json(await request('POST', '/release/update', { sourceDir }));
    return;
  }

  if (command === 'rollback') {
    json(await request('POST', '/release/rollback', { target: args[0] || 'previous' }));
    return;
  }

  if (command === 'sentry') {
    const sub = args[0] || 'status';
    if (sub === 'status') {
      json(await request('GET', '/sentry/status'));
      return;
    }
    fail(`unknown sentry command: ${sub}`, 'Use: sentry status');
  }

  if (command === 'audit') {
    const deep = args.includes('--deep');
    runRepoScript('bin/security-audit.sh', deep ? ['--deep'] : []);
    return;
  }

  if (command === 'prune') {
    const days = args[0] || process.env.SESSION_LOG_RETENTION_DAYS || '14';
    runRepoScript('bin/prune-session-logs.sh', [days]);
    return;
  }

  if (command === 'firewall') {
    const dryRun = args.includes('--dry-run');
    runRepoScript('bin/setup-firewall.sh', dryRun ? ['--dry-run'] : []);
    return;
  }

  if (command === 'bundle') {
    json(await request('POST', '/diagnostics/bundle', { outputDir: getFlag(args, 'output') || '/tmp' }));
    return;
  }

  if (command === 'uninstall') {
    const force = args.includes('--force');
    if (!force) {
      fail('uninstall requires --force', 'Use `talonbot uninstall --force [--purge]`.');
    }
    const purge = args.includes('--purge');
    runRepoScript('bin/uninstall.sh', purge ? ['--purge'] : []);
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }

  fail(`unknown command: ${command}`, 'Use `talonbot --help` to list commands.');
};

main().catch((error) => {
  const cliError = error as CliError;
  process.stderr.write(`talonbot cli error: ${cliError.message}\n`);
  if (cliError.hint) {
    process.stderr.write(`talonbot cli hint: ${cliError.hint}\n`);
  }
  process.exit(1);
});
