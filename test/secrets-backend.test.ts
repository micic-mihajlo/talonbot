import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { applyConfigSecretResolution, resolveConfigSecrets } from '../src/security/secrets.js';

const tempDirs: string[] = [];

const createTempDir = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'talonbot-secrets-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('secret backend resolution', () => {
  it('uses env backend by default', () => {
    const env: NodeJS.ProcessEnv = {
      CONTROL_AUTH_TOKEN: 'env-token',
    };

    const resolved = resolveConfigSecrets(env);
    expect(resolved.CONTROL_AUTH_TOKEN).toBe('env-token');
  });

  it('uses file backend when *_FILE is present and trims line breaks', async () => {
    const dir = await createTempDir();
    const secretFile = path.join(dir, 'control.token');
    await writeFile(secretFile, 'file-token\n', { encoding: 'utf8', mode: 0o600 });

    const env: NodeJS.ProcessEnv = {
      CONTROL_AUTH_TOKEN_FILE: secretFile,
    };

    const resolved = resolveConfigSecrets(env);
    expect(resolved.CONTROL_AUTH_TOKEN).toBe('file-token');
  });

  it('fails file backend when path is not absolute', () => {
    expect(() =>
      resolveConfigSecrets({
        CONTROL_AUTH_TOKEN_FILE: './relative-secret.txt',
      }),
    ).toThrow(/absolute path/);
  });

  it('requires command backend opt-in', () => {
    const command = JSON.stringify([process.execPath, '-e', 'process.stdout.write("cmd-token")']);
    expect(() =>
      resolveConfigSecrets({
        CONTROL_AUTH_TOKEN_COMMAND: command,
      }),
    ).toThrow(/command backend is disabled/);
  });

  it('resolves command backend when enabled', () => {
    const command = JSON.stringify([process.execPath, '-e', 'process.stdout.write("cmd-token\\n")']);
    const resolved = resolveConfigSecrets({
      CONTROL_AUTH_TOKEN_COMMAND: command,
      TALONBOT_SECRET_ALLOW_COMMAND: 'true',
    });
    expect(resolved.CONTROL_AUTH_TOKEN).toBe('cmd-token');
  });

  it('supports explicit backend override', async () => {
    const dir = await createTempDir();
    const secretFile = path.join(dir, 'control.token');
    await writeFile(secretFile, 'file-token', { encoding: 'utf8', mode: 0o600 });

    const resolved = resolveConfigSecrets({
      CONTROL_AUTH_TOKEN_BACKEND: 'env',
      CONTROL_AUTH_TOKEN: 'env-token',
      CONTROL_AUTH_TOKEN_FILE: secretFile,
    });

    expect(resolved.CONTROL_AUTH_TOKEN).toBe('env-token');
  });

  it('fails with invalid backend name', () => {
    expect(() =>
      resolveConfigSecrets({
        CONTROL_AUTH_TOKEN_BACKEND: 'vault',
      }),
    ).toThrow(/must be one of env,file,command/);
  });

  it('applies resolved values to process-style env map', () => {
    const env: NodeJS.ProcessEnv = {
      CONTROL_AUTH_TOKEN: 'inline',
    };
    applyConfigSecretResolution(env);
    expect(env.CONTROL_AUTH_TOKEN).toBe('inline');
  });
});
