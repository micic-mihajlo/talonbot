import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const repoRoot = '/Users/mihajlomicic/talonbot';

const exists = async (target: string) =>
  access(target)
    .then(() => true)
    .catch(() => false);

const run = (script: string, args: string[], env: Record<string, string> = {}) => {
  return execFileSync(path.join(repoRoot, script), args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    encoding: 'utf8',
  });
};

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

describe('ops shell scripts', () => {
  let sandbox = '';

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), 'talon-shell-'));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('redacts and prunes session logs', async () => {
    const dataDir = path.join(sandbox, 'data');
    const oldSession = path.join(dataDir, 'sessions', 'old');
    const newSession = path.join(dataDir, 'sessions', 'new');

    await mkdir(oldSession, { recursive: true });
    await mkdir(newSession, { recursive: true });

    await writeFile(path.join(oldSession, 'log.jsonl'), '{"token":"sk-old-secret-123456"}\n', 'utf8');
    await writeFile(path.join(newSession, 'log.jsonl'), '{"token":"xoxb-new-secret-123456"}\n', 'utf8');

    const old = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await utimes(oldSession, old, old);

    run('bin/prune-session-logs.sh', ['1'], { DATA_DIR: dataDir });
    expect(await exists(oldSession)).toBe(false);
    expect(await exists(newSession)).toBe(true);

    run('bin/redact-logs.sh', [], { DATA_DIR: dataDir });
    const redacted = await readFile(path.join(newSession, 'log.jsonl'), 'utf8');
    expect(redacted.includes('[REDACTED]')).toBe(true);
  });

  it('verifies release manifest in strict mode', async () => {
    const releaseRoot = path.join(sandbox, 'releases');
    const releaseDir = path.join(releaseRoot, 'releases', 'abc123');
    const dataDir = path.join(sandbox, 'data');
    const file = path.join(releaseDir, 'file.txt');

    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.join(dataDir, 'security'), { recursive: true });

    await writeFile(file, 'hello-manifest', 'utf8');
    const manifest = {
      generatedAt: new Date().toISOString(),
      files: {
        'file.txt': hash('hello-manifest'),
      },
    };
    await writeFile(path.join(releaseDir, 'release-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    await mkdir(releaseRoot, { recursive: true });
    await symlink(path.join('releases', 'abc123'), path.join(releaseRoot, 'current'));

    const ok = run('bin/verify-manifest.sh', [], {
      RELEASE_ROOT_DIR: releaseRoot,
      DATA_DIR: dataDir,
      STARTUP_INTEGRITY_MODE: 'strict',
    });
    expect(ok.includes('verify-manifest: pass')).toBe(true);

    await writeFile(file, 'tampered', 'utf8');
    let failed = false;
    try {
      run('bin/verify-manifest.sh', [], {
        RELEASE_ROOT_DIR: releaseRoot,
        DATA_DIR: dataDir,
        STARTUP_INTEGRITY_MODE: 'strict',
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });

  it('safe bash blocks dangerous commands and allows safe ones', () => {
    const safe = run('bin/talonbot-safe-bash', ['echo safe']);
    expect(safe.trim()).toBe('safe');

    let blocked = false;
    try {
      run('bin/talonbot-safe-bash', ['rm -rf /']);
    } catch {
      blocked = true;
    }
    expect(blocked).toBe(true);
  });

  it('security audit passes with valid config and release state', async () => {
    const dataDir = path.join(sandbox, 'data');
    const configDir = path.join(sandbox, 'config');
    const releaseRoot = path.join(sandbox, 'releases');
    const releaseDir = path.join(releaseRoot, 'releases', 'ok1');

    await mkdir(releaseDir, { recursive: true });
    await mkdir(path.join(dataDir, 'security'), { recursive: true });
    await mkdir(configDir, { recursive: true });

    await writeFile(path.join(configDir, '.env'), 'CONTROL_AUTH_TOKEN=super-long-test-token-1234567890\n', 'utf8');
    await writeFile(path.join(releaseDir, 'payload.txt'), 'ok', 'utf8');

    const manifest = {
      generatedAt: new Date().toISOString(),
      files: {
        'payload.txt': hash('ok'),
      },
    };
    await writeFile(path.join(releaseDir, 'release-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await symlink(path.join('releases', 'ok1'), path.join(releaseRoot, 'current'));

    const result = run('bin/security-audit.sh', [], {
      DATA_DIR: dataDir,
      CONFIG_FILE: path.join(configDir, '.env'),
      RELEASE_ROOT_DIR: releaseRoot,
      STARTUP_INTEGRITY_MODE: 'strict',
      SESSION_LOG_RETENTION_DAYS: '1',
    });

    expect(result.includes('audit summary')).toBe(true);
    expect(result.includes('errors=0')).toBe(true);
  });
});
