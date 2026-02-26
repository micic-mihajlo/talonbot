import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const strList = (value: string | undefined) =>
  value
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const bool = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  return false;
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATA_DIR: z.string().default(`${process.env.HOME}/.local/share/talonbot`),
  SESSION_MAX_MESSAGES: z.coerce.number().int().min(20).max(100000).default(500),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).default(3600),
  SESSION_DEDUPE_WINDOW_MS: z.coerce.number().int().min(100).max(600000).default(30000),
  CONTROL_HTTP_PORT: z.coerce.number().int().min(0).default(0),
  CONTROL_AUTH_TOKEN: z.string().default(''),
  CONTROL_SOCKET_PATH: z.string().default(`${process.env.HOME}/.local/share/talonbot/control.sock`),

  MAX_QUEUE_PER_SESSION: z.coerce.number().int().min(1).max(200).default(16),
  MAX_MESSAGE_BYTES: z.coerce.number().int().min(128).default(12000),

  ENGINE_MODE: z.enum(['process', 'mock']).default('process'),
  ENGINE_COMMAND: z.string().default('pi'),
  ENGINE_ARGS: z.string().default(''),
  ENGINE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),

  REPO_ROOT_DIR: z.string().default(`${process.env.HOME}/workspace`),
  WORKTREE_ROOT_DIR: z.string().default(`${process.env.HOME}/workspace/worktrees`),
  RELEASE_ROOT_DIR: z.string().default(`${process.env.HOME}/.local/share/talonbot/releases`),
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
  BRIDGE_STATE_FILE: z.string().default(`${process.env.HOME}/.local/share/talonbot/bridge/state.json`),

  SLACK_ENABLED: bool.default(false),
  SLACK_BOT_TOKEN: z.string().default(''),
  SLACK_APP_TOKEN: z.string().default(''),
  SLACK_SIGNING_SECRET: z.string().default(''),
  SLACK_ALLOWED_CHANNELS: z.string().default(''),
  SLACK_ALLOWED_CHANNEL_PREFIXES: z.string().default(''),
  SLACK_ALLOWED_USERS: z.string().default(''),

  DISCORD_ENABLED: bool.default(false),
  DISCORD_TOKEN: z.string().default(''),
  DISCORD_ALLOWED_CHANNELS: z.string().default(''),
  DISCORD_ALLOWED_GUILDS: z.string().default(''),
  DISCORD_ALLOWED_USERS: z.string().default(''),
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  SLACK_ALLOWED_CHANNELS: strList(parsed.SLACK_ALLOWED_CHANNELS),
  SLACK_ALLOWED_CHANNEL_PREFIXES: strList(parsed.SLACK_ALLOWED_CHANNEL_PREFIXES),
  SLACK_ALLOWED_USERS: strList(parsed.SLACK_ALLOWED_USERS),
  DISCORD_ALLOWED_CHANNELS: strList(parsed.DISCORD_ALLOWED_CHANNELS),
  DISCORD_ALLOWED_GUILDS: strList(parsed.DISCORD_ALLOWED_GUILDS),
  DISCORD_ALLOWED_USERS: strList(parsed.DISCORD_ALLOWED_USERS),
};

export type AppConfig = typeof config;
