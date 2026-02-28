import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type SecretBackend = 'env' | 'file' | 'command';

const SECRET_BACKENDS: ReadonlySet<SecretBackend> = new Set(['env', 'file', 'command']);

export const CONFIG_SECRET_KEYS = [
  'CONTROL_AUTH_TOKEN',
  'BRIDGE_SHARED_SECRET',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_SIGNING_SECRET',
  'DISCORD_TOKEN',
] as const;

const parseBool = (value: string | undefined, fallback: boolean) => {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
};

const parseBoundedInt = (name: string, raw: string | undefined, fallback: number, min: number, max: number) => {
  if (raw === undefined || raw === '') {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
};

const stripTrailingLineBreaks = (value: string) => value.replace(/(?:\r?\n)+$/g, '');

const validateSecretValue = (name: string, value: string, maxSecretBytes: number) => {
  if (value.includes('\u0000')) {
    throw new Error(`${name} contains NUL bytes`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxSecretBytes) {
    throw new Error(`${name} exceeds TALONBOT_SECRET_MAX_BYTES (${maxSecretBytes})`);
  }
  return value;
};

const readSecretFile = (name: string, filePath: string, maxSecretBytes: number) => {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`${name}_FILE must be an absolute path`);
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    throw new Error(`${name}_FILE path is not readable: ${(error as Error).message}`);
  }

  if (!stats.isFile()) {
    throw new Error(`${name}_FILE must point to a file`);
  }
  if (stats.size > maxSecretBytes) {
    throw new Error(`${name}_FILE exceeds TALONBOT_SECRET_MAX_BYTES (${maxSecretBytes})`);
  }

  const raw = fs.readFileSync(filePath, { encoding: 'utf8' });
  return validateSecretValue(name, stripTrailingLineBreaks(raw), maxSecretBytes);
};

const parseCommandArgv = (name: string, raw: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name}_COMMAND must be a JSON array of argv strings: ${(error as Error).message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name}_COMMAND must be a non-empty JSON array of non-empty strings`);
  }

  const argv = parsed as string[];
  if (!path.isAbsolute(argv[0])) {
    throw new Error(`${name}_COMMAND argv[0] must be an absolute executable path`);
  }

  return argv;
};

const readSecretCommand = (
  name: string,
  rawCommand: string,
  maxSecretBytes: number,
  commandTimeoutMs: number,
  allowCommandBackend: boolean,
) => {
  if (!allowCommandBackend) {
    throw new Error(`${name}_COMMAND is set but command backend is disabled (set TALONBOT_SECRET_ALLOW_COMMAND=true to enable)`);
  }

  const argv = parseCommandArgv(name, rawCommand);
  try {
    const raw = execFileSync(argv[0], argv.slice(1), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: commandTimeoutMs,
      maxBuffer: maxSecretBytes,
    });
    return validateSecretValue(name, stripTrailingLineBreaks(raw), maxSecretBytes);
  } catch (error) {
    throw new Error(`${name}_COMMAND execution failed: ${(error as Error).message}`);
  }
};

const resolveBackend = (name: string, inputEnv: NodeJS.ProcessEnv): SecretBackend => {
  const explicit = inputEnv[`${name}_BACKEND`];
  if (explicit && explicit.trim()) {
    const normalized = explicit.trim().toLowerCase();
    if (!SECRET_BACKENDS.has(normalized as SecretBackend)) {
      throw new Error(`${name}_BACKEND must be one of env,file,command`);
    }
    return normalized as SecretBackend;
  }

  if (inputEnv[`${name}_FILE`]) {
    return 'file';
  }
  if (inputEnv[`${name}_COMMAND`]) {
    return 'command';
  }
  return 'env';
};

export interface SecretResolverOptions {
  allowCommandBackend: boolean;
  commandTimeoutMs: number;
  maxSecretBytes: number;
}

export const readSecretResolverOptions = (inputEnv: NodeJS.ProcessEnv): SecretResolverOptions => ({
  allowCommandBackend: parseBool(inputEnv.TALONBOT_SECRET_ALLOW_COMMAND, false),
  commandTimeoutMs: parseBoundedInt(
    'TALONBOT_SECRET_COMMAND_TIMEOUT_MS',
    inputEnv.TALONBOT_SECRET_COMMAND_TIMEOUT_MS,
    3000,
    100,
    120000,
  ),
  maxSecretBytes: parseBoundedInt('TALONBOT_SECRET_MAX_BYTES', inputEnv.TALONBOT_SECRET_MAX_BYTES, 8192, 64, 1024 * 1024),
});

export const resolveConfigSecrets = (
  inputEnv: NodeJS.ProcessEnv,
  options: SecretResolverOptions = readSecretResolverOptions(inputEnv),
) => {
  const resolved: NodeJS.ProcessEnv = { ...inputEnv };

  for (const key of CONFIG_SECRET_KEYS) {
    const backend = resolveBackend(key, inputEnv);
    let value = '';

    if (backend === 'env') {
      value = validateSecretValue(key, inputEnv[key] || '', options.maxSecretBytes);
    } else if (backend === 'file') {
      value = readSecretFile(key, inputEnv[`${key}_FILE`] || '', options.maxSecretBytes);
    } else {
      value = readSecretCommand(
        key,
        inputEnv[`${key}_COMMAND`] || '',
        options.maxSecretBytes,
        options.commandTimeoutMs,
        options.allowCommandBackend,
      );
    }

    resolved[key] = value;
  }

  return resolved;
};

export const applyConfigSecretResolution = (targetEnv: NodeJS.ProcessEnv) => {
  const resolved = resolveConfigSecrets(targetEnv);
  for (const key of CONFIG_SECRET_KEYS) {
    targetEnv[key] = resolved[key];
  }
};
