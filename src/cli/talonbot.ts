#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { config } from '../config.js';

const baseUrl = `http://127.0.0.1:${config.CONTROL_HTTP_PORT || 8080}`;

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

  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => ({ error: 'invalid_json_response' }));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(payload)}`);
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

const help = () => {
  process.stdout.write(`talonbot CLI\n\n`);
  process.stdout.write(`Commands:\n`);
  process.stdout.write(`  start|stop|restart|status|logs\n`);
  process.stdout.write(`  sessions|attach --session <sessionKey>\n`);
  process.stdout.write(`  doctor\n`);
  process.stdout.write(`  env get|set|list|sync\n`);
  process.stdout.write(`  tasks list|get|create|retry|cancel\n`);
  process.stdout.write(`  repos list|register|remove\n`);
  process.stdout.write(`  deploy|update [--source <path>]\n`);
  process.stdout.write(`  rollback [target]\n`);
  process.stdout.write(`  audit [--deep]|prune [days]|firewall [--dry-run]\n`);
  process.stdout.write(`  bundle [--output <path>]\n`);
  process.stdout.write(`  uninstall --force [--purge]\n`);
};

const main = async () => {
  const { command, args } = parseArgs(process.argv);

  if (['start', 'stop', 'restart', 'logs'].includes(command)) {
    runSystemctl(command as 'start' | 'stop' | 'restart' | 'logs');
    return;
  }

  if (command === 'status') {
    try {
      runSystemctl('status');
      return;
    } catch {
      json(await request('GET', '/status'));
      return;
    }
  }

  if (command === 'sessions') {
    json(await request('GET', '/sessions'));
    return;
  }

  if (command === 'attach') {
    const session = getFlag(args, 'session') || args[0];
    if (!session) {
      throw new Error('attach requires --session <sessionKey>');
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
      if (!key) throw new Error('env get requires a key');
      const values = await readEnvMap();
      json({ key, value: values.get(key) || '' });
      return;
    }

    if (sub === 'set') {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) throw new Error('env set requires key and value');
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

    throw new Error(`unknown env command: ${sub}`);
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
      if (!id) throw new Error('task id required');
      json(await request('GET', `/tasks/${encodeURIComponent(id)}`));
      return;
    }

    if (sub === 'create') {
      const repoId = getFlag(args, 'repo');
      const text = getFlag(args, 'text') || args.filter((arg) => !arg.startsWith('--') && arg !== 'create').join(' ');
      const fanoutArg = getFlag(args, 'fanout');
      const fanout = fanoutArg ? fanoutArg.split('|').map((item) => item.trim()).filter(Boolean) : undefined;
      if (!text.trim()) throw new Error('task text required');
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
      if (!id) throw new Error('task id required');
      json(await request('POST', `/tasks/${encodeURIComponent(id)}/retry`));
      return;
    }

    if (sub === 'cancel') {
      const id = args[1];
      if (!id) throw new Error('task id required');
      json(await request('POST', `/tasks/${encodeURIComponent(id)}/cancel`));
      return;
    }

    throw new Error(`unknown tasks command: ${sub}`);
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
        throw new Error('repos register requires --id and --path');
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
      if (!id) throw new Error('repo id required');
      json(await request('POST', '/repos/remove', { id }));
      return;
    }

    throw new Error(`unknown repos command: ${sub}`);
  }

  if (command === 'deploy' || command === 'update') {
    json(await request('POST', '/release/update', { sourceDir: getFlag(args, 'source') || process.cwd() }));
    return;
  }

  if (command === 'rollback') {
    json(await request('POST', '/release/rollback', { target: args[0] || 'previous' }));
    return;
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
      throw new Error('uninstall requires --force');
    }
    const purge = args.includes('--purge');
    runRepoScript('bin/uninstall.sh', purge ? ['--purge'] : []);
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }

  throw new Error(`unknown command: ${command}`);
};

main().catch((error) => {
  process.stderr.write(`talonbot cli error: ${(error as Error).message}\n`);
  process.exit(1);
});
