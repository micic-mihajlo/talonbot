import path from 'node:path';
import { config as loadDotenv, type DotenvParseOutput } from 'dotenv';
import { z, type ZodIssue } from 'zod';
import { applyConfigSecretResolution } from './security/secrets.js';

const bool = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return value;
  }
  return value;
}, z.boolean());

const strList = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const schemaBase = z.object({
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATA_DIR: z.string().default('~/.local/share/talonbot'),
  SESSION_MAX_MESSAGES: z.coerce.number().int().min(20).max(100000).default(500),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  SESSION_DEDUPE_WINDOW_MS: z.coerce.number().int().min(100).max(600000).default(30000),
  CONTROL_HTTP_PORT: z.coerce.number().int().min(0).default(0),
  CONTROL_AUTH_TOKEN: z.string().default(''),
  CONTROL_SOCKET_PATH: z.string().default('~/.local/share/talonbot/control.sock'),

  MAX_QUEUE_PER_SESSION: z.coerce.number().int().min(1).max(200).default(16),
  MAX_MESSAGE_BYTES: z.coerce.number().int().min(128).default(12000),

  ENGINE_MODE: z.enum(['process', 'mock', 'session']).default('process'),
  ENGINE_COMMAND: z.string().default('pi'),
  ENGINE_ARGS: z.string().default(''),
  ENGINE_CWD: z.string().default('~/.local/share/talonbot/engine'),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),

  REPO_ROOT_DIR: z.string().default('~/workspace'),
  WORKTREE_ROOT_DIR: z.string().default('~/workspace/worktrees'),
  RELEASE_ROOT_DIR: z.string().default('~/.local/share/talonbot/releases'),
  TASK_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(3),
  WORKER_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  WORKTREE_STALE_HOURS: z.coerce.number().int().min(1).max(24 * 365).default(24),
  TASK_AUTOCLEANUP: bool.default(true),
  TASK_AUTO_COMMIT: bool.default(false),
  TASK_AUTO_PR: bool.default(false),
  STARTUP_INTEGRITY_MODE: z.enum(['off', 'warn', 'strict']).default('warn'),
  SESSION_LOG_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  ENABLE_WEBHOOK_BRIDGE: bool.default(true),
  BRIDGE_SHARED_SECRET: z.string().default(''),
  BRIDGE_RETRY_BASE_MS: z.coerce.number().int().min(100).max(120000).default(2000),
  BRIDGE_RETRY_MAX_MS: z.coerce.number().int().min(500).max(600000).default(30000),
  BRIDGE_MAX_RETRIES: z.coerce.number().int().min(0).max(100).default(5),
  BRIDGE_STATE_FILE: z.string().default('~/.local/share/talonbot/bridge/state.json'),
  PR_CHECK_TIMEOUT_MS: z.coerce.number().int().min(1000).max(24 * 60 * 60 * 1000).default(15 * 60 * 1000),
  PR_CHECK_POLL_MS: z.coerce.number().int().min(500).max(60 * 60 * 1000).default(15000),
  SENTRY_ENABLED: bool.default(true),
  SENTRY_POLL_MS: z.coerce.number().int().min(500).max(60 * 60 * 1000).default(10000),
  SENTRY_STATE_FILE: z.string().default('~/.local/share/talonbot/sentry/incidents.jsonl'),

  SLACK_ENABLED: bool.default(false),
  SLACK_BOT_TOKEN: z.string().default(''),
  SLACK_APP_TOKEN: z.string().default(''),
  SLACK_SIGNING_SECRET: z.string().default(''),
  SLACK_ALLOWED_CHANNELS: z.string().default(''),
  SLACK_ALLOWED_CHANNEL_PREFIXES: z.string().default(''),
  SLACK_ALLOWED_USERS: z.string().default(''),

  DISCORD_ENABLED: bool.default(false),
  DISCORD_TOKEN: z.string().default(''),
  DISCORD_TYPING_ENABLED: bool.default(true),
  DISCORD_REACTIONS_ENABLED: bool.default(true),
  DISCORD_ALLOWED_CHANNELS: z.string().default(''),
  DISCORD_ALLOWED_GUILDS: z.string().default(''),
  DISCORD_ALLOWED_USERS: z.string().default(''),

  TALONBOT_SECRET_ALLOW_COMMAND: bool.default(false),
  TALONBOT_SECRET_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(3000),
  TALONBOT_SECRET_MAX_BYTES: z.coerce.number().int().min(64).max(1024 * 1024).default(8192),
});

export const appConfigSchema = schemaBase.superRefine((input, ctx) => {
  if (input.ENGINE_MODE === 'process' && !input.ENGINE_COMMAND.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ENGINE_COMMAND'],
      message: 'ENGINE_MODE=process requires ENGINE_COMMAND to be set.',
    });
  }

  if (input.TASK_AUTO_PR && !input.TASK_AUTO_COMMIT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TASK_AUTO_PR'],
      message: 'TASK_AUTO_PR=true requires TASK_AUTO_COMMIT=true.',
    });
  }

  if (input.SLACK_ENABLED && (!input.SLACK_BOT_TOKEN || !input.SLACK_APP_TOKEN || !input.SLACK_SIGNING_SECRET)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['SLACK_ENABLED'],
      message: 'SLACK_ENABLED=true requires SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET.',
    });
  }

  if (input.DISCORD_ENABLED && !input.DISCORD_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DISCORD_ENABLED'],
      message: 'DISCORD_ENABLED=true requires DISCORD_TOKEN.',
    });
  }
});

type SchemaInput = z.input<typeof appConfigSchema>;
type SchemaOutput = z.output<typeof appConfigSchema>;

const CONFIG_KEYS = Object.keys(schemaBase.shape) as Array<keyof SchemaInput>;
const KNOWN_CONFIG_KEYS = new Set<string>(CONFIG_KEYS as string[]);

const ALLOWED_FOREIGN_ENV_KEYS = new Set<string>([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'MINIMAX_API_KEY',
  'CEREBRAS_API_KEY',
]);

const formatIssue = (issue: ZodIssue) => {
  const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${key}: ${issue.message}`;
};

export const formatConfigSchemaIssues = (issues: ZodIssue[]): string =>
  issues.map((issue) => `- ${formatIssue(issue)}`).join('\n');

const unknownDotenvKeys = (input: DotenvParseOutput | undefined): string[] => {
  if (!input) return [];
  return Object.keys(input)
    .filter((key) => !KNOWN_CONFIG_KEYS.has(key) && !ALLOWED_FOREIGN_ENV_KEYS.has(key))
    .sort();
};

const pickConfigValues = (env: NodeJS.ProcessEnv): SchemaInput => {
  const output: Record<string, string | undefined> = {};
  for (const key of CONFIG_KEYS) {
    output[key] = env[key];
  }
  return output as SchemaInput;
};

const envFilePath = process.env.TALONBOT_ENV_FILE || path.join(process.cwd(), '.env');
const dotenvOutput = loadDotenv({ path: envFilePath });
applyConfigSecretResolution(process.env);
if (dotenvOutput.error && (dotenvOutput.error as NodeJS.ErrnoException).code !== 'ENOENT') {
  throw new Error(`Unable to load config file ${envFilePath}: ${dotenvOutput.error.message}`);
}

const parseSchema = (env: NodeJS.ProcessEnv): SchemaOutput => {
  const parsed = appConfigSchema.safeParse(pickConfigValues(env));
  if (!parsed.success) {
    throw new Error(`Invalid talonbot configuration:\n${formatConfigSchemaIssues(parsed.error.issues)}`);
  }
  return parsed.data;
};

export const parseAppConfig = (
  env: NodeJS.ProcessEnv = process.env,
  dotenvVars: DotenvParseOutput | undefined = dotenvOutput.parsed,
) => {
  const unknown = unknownDotenvKeys(dotenvVars);
  if (unknown.length > 0) {
    throw new Error(`Unknown config key(s) in ${envFilePath}: ${unknown.join(', ')}`);
  }

  const parsed = parseSchema(env);
  return {
    ...parsed,
    SLACK_ALLOWED_CHANNELS: strList(parsed.SLACK_ALLOWED_CHANNELS),
    SLACK_ALLOWED_CHANNEL_PREFIXES: strList(parsed.SLACK_ALLOWED_CHANNEL_PREFIXES),
    SLACK_ALLOWED_USERS: strList(parsed.SLACK_ALLOWED_USERS),
    DISCORD_ALLOWED_CHANNELS: strList(parsed.DISCORD_ALLOWED_CHANNELS),
    DISCORD_ALLOWED_GUILDS: strList(parsed.DISCORD_ALLOWED_GUILDS),
    DISCORD_ALLOWED_USERS: strList(parsed.DISCORD_ALLOWED_USERS),
  };
};

export const config = parseAppConfig();

export type AppConfig = ReturnType<typeof parseAppConfig>;
