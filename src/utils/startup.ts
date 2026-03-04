import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AppConfig } from '../config.js';
import { expandPath } from './path.js';

export interface StartupIssue {
  severity: 'warn' | 'error';
  area: string;
  message: string;
  remediation?: string;
  code?: string;
}

export class StartupValidationError extends Error {
  readonly issues: StartupIssue[];
  readonly errorCount: number;

  constructor(issues: StartupIssue[]) {
    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    super(`Startup validation failed with ${errorCount} error(s).`);
    this.name = 'StartupValidationError';
    this.issues = issues;
    this.errorCount = errorCount;
  }
}

const ensureDirWritable = (targetPath: string): string | null => {
  try {
    fs.mkdirSync(targetPath, { recursive: true });
    fs.accessSync(targetPath, fs.constants.F_OK | fs.constants.R_OK | fs.constants.W_OK);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

const SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 103 : 107;

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

const issue = (entry: StartupIssue): StartupIssue => entry;

export const formatStartupIssue = (input: StartupIssue) => {
  if (!input.remediation) {
    return input.message;
  }
  return `${input.message} Remediation: ${input.remediation}`;
};

export const validateStartupConfig = (config: AppConfig): StartupIssue[] => {
  const issues: StartupIssue[] = [];
  const strict = config.STARTUP_INTEGRITY_MODE === 'strict';

  const expandedDataDir = expandPath(config.DATA_DIR);
  const expandedSocketPath = expandPath(config.CONTROL_SOCKET_PATH);
  const expandedSocketDir = path.dirname(expandedSocketPath);
  const expandedWorktreeDir = expandPath(config.WORKTREE_ROOT_DIR);
  const expandedReleaseDir = expandPath(config.RELEASE_ROOT_DIR);
  const expandedEngineDir = expandPath(config.ENGINE_CWD);
  const expandedQmdWorkspaceDir = expandPath(config.QMD_WORKSPACE_DIR);
  const expandedOutboxStateFile = expandPath(config.TRANSPORT_OUTBOX_STATE_FILE);
  const expandedOutboxDir = path.dirname(expandedOutboxStateFile);

  if (!config.CONTROL_AUTH_TOKEN) {
    issues.push(
      issue({
        severity: 'warn',
        area: 'control-plane',
        message: 'CONTROL_AUTH_TOKEN is empty; HTTP/socket control endpoints are unauthenticated.',
        remediation: 'Set CONTROL_AUTH_TOKEN in .env to a long random value (recommended: >=24 chars), then restart talonbot.',
        code: 'missing_control_auth_token',
      }),
    );
  } else if (config.CONTROL_AUTH_TOKEN.length < 24) {
    issues.push(
      issue({
        severity: 'warn',
        area: 'control-plane',
        message: 'CONTROL_AUTH_TOKEN is short; use at least 24 characters.',
        remediation: 'Regenerate CONTROL_AUTH_TOKEN with a longer value and restart talonbot.',
        code: 'weak_control_auth_token',
      }),
    );
  }

  if (config.TALONBOT_SECRET_ALLOW_COMMAND) {
    issues.push(
      issue({
        severity: 'warn',
        area: 'security',
        message: 'TALONBOT_SECRET_ALLOW_COMMAND=true enables command execution for secret loading.',
        remediation:
          'Prefer *_FILE for production secrets when possible. If command backend is required, keep command paths absolute and tightly controlled.',
        code: 'secret_command_backend_enabled',
      }),
    );
  }

  if (config.ENGINE_MODE === 'process' && !config.ENGINE_COMMAND.trim()) {
    issues.push(
      issue({
        severity: 'error',
        area: 'engine',
        message: 'ENGINE_MODE=process requires ENGINE_COMMAND to be set.',
        remediation:
          'Set ENGINE_COMMAND to an installed executable (for example: codex) or switch ENGINE_MODE=mock for local smoke testing.',
        code: 'missing_engine_command',
      }),
    );
  } else if (config.ENGINE_MODE === 'process' && !commandExists(config.ENGINE_COMMAND)) {
    issues.push(
      issue({
        severity: 'error',
        area: 'engine',
        message: `ENGINE_COMMAND "${config.ENGINE_COMMAND}" is not executable or not on PATH.`,
        remediation: 'Install the command, use an absolute ENGINE_COMMAND path, or switch ENGINE_MODE=mock.',
        code: 'engine_command_not_found',
      }),
    );
  }

  if (config.WORKER_RUNTIME === 'tmux') {
    if (!commandExists(config.TMUX_BINARY)) {
      issues.push(
        issue({
          severity: 'error',
          area: 'orchestration',
          message: `TMUX_BINARY "${config.TMUX_BINARY}" is not executable or not on PATH.`,
          remediation: 'Install tmux or set TMUX_BINARY to an absolute tmux path.',
          code: 'tmux_binary_not_found',
        }),
      );
    }
    if (config.ENGINE_MODE !== 'process') {
      issues.push(
        issue({
          severity: 'error',
          area: 'orchestration',
          message: 'WORKER_RUNTIME=tmux requires ENGINE_MODE=process.',
          remediation: 'Set ENGINE_MODE=process when enabling tmux worker runtime.',
          code: 'tmux_runtime_engine_mode_mismatch',
        }),
      );
    }
  }

  if (config.MEMORY_PROVIDER === 'qmd') {
    if (!config.QMD_COMMAND.trim()) {
      issues.push(
        issue({
          severity: strict ? 'error' : 'warn',
          area: 'memory',
          message: 'MEMORY_PROVIDER=qmd requires QMD_COMMAND to be set.',
          remediation: 'Set QMD_COMMAND to the installed qmd executable path or command name.',
          code: 'qmd_command_missing',
        }),
      );
    } else if (!commandExists(config.QMD_COMMAND)) {
      issues.push(
        issue({
          severity: strict ? 'error' : 'warn',
          area: 'memory',
          message: `QMD command "${config.QMD_COMMAND}" is not executable or not on PATH.`,
          remediation: 'Install qmd or point QMD_COMMAND to an absolute executable path.',
          code: 'qmd_command_not_found',
        }),
      );
    }

    const qmdWorkspaceErr = ensureDirWritable(expandedQmdWorkspaceDir);
    if (qmdWorkspaceErr) {
      issues.push(
        issue({
          severity: strict ? 'error' : 'warn',
          area: 'memory',
          message: `QMD_WORKSPACE_DIR "${expandedQmdWorkspaceDir}" is not writable: ${qmdWorkspaceErr}`,
          remediation: 'Create and chown the qmd workspace directory for the runtime user.',
          code: 'qmd_workspace_not_writable',
        }),
      );
    }
  }

  if (config.TASK_AUTO_PR && !config.TASK_AUTO_COMMIT) {
    issues.push(
      issue({
        severity: 'warn',
        area: 'orchestration',
        message: 'TASK_AUTO_PR=true without TASK_AUTO_COMMIT=true will skip PR creation.',
        remediation: 'Set TASK_AUTO_COMMIT=true if you want automatic PR creation, or set TASK_AUTO_PR=false.',
        code: 'auto_pr_without_commit',
      }),
    );
  }

  if (!config.DISCORD_ENABLED && !config.SLACK_ENABLED) {
    issues.push(
      issue({
        severity: 'warn',
        area: 'transports',
        message: 'No chat transport enabled; only control-plane APIs will be available.',
        remediation: 'Enable SLACK_ENABLED=true or DISCORD_ENABLED=true and provide the required token variables.',
        code: 'no_transport_enabled',
      }),
    );
  }

  const chatSdkProviderEnabled =
    config.CHAT_TRANSPORT_PROVIDER === 'chat_sdk' || config.CHAT_TRANSPORT_PROVIDER === 'dual';
  if (chatSdkProviderEnabled && !config.CHAT_SDK_REDIS_URL.trim()) {
    issues.push(
      issue({
        severity: 'error',
        area: 'transports',
        message: 'CHAT_TRANSPORT_PROVIDER requires CHAT_SDK_REDIS_URL when chat-sdk transport is enabled.',
        remediation: 'Set CHAT_SDK_REDIS_URL=redis://<host>:6379/<db> and restart talonbot.',
        code: 'chat_sdk_redis_url_missing',
      }),
    );
  }

  if (chatSdkProviderEnabled && config.CHAT_SDK_REDIS_URL.trim()) {
    try {
      const parsed = new URL(config.CHAT_SDK_REDIS_URL);
      if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
        issues.push(
          issue({
            severity: strict ? 'error' : 'warn',
            area: 'transports',
            message: `CHAT_SDK_REDIS_URL protocol must be redis:// or rediss:// (received ${parsed.protocol}).`,
            remediation: 'Use a Redis URL like redis://localhost:6379/0 or rediss://host:6379/0.',
            code: 'chat_sdk_redis_url_invalid_protocol',
          }),
        );
      }
    } catch {
      issues.push(
        issue({
          severity: strict ? 'error' : 'warn',
          area: 'transports',
          message: 'CHAT_SDK_REDIS_URL is not a valid URL.',
          remediation: 'Set CHAT_SDK_REDIS_URL=redis://<host>:6379/<db>.',
          code: 'chat_sdk_redis_url_invalid',
        }),
      );
    }
  }

  if (config.CHAT_REQUIRE_VERIFIED_PR && !commandExists('gh')) {
    issues.push(
      issue({
        severity: strict ? 'error' : 'warn',
        area: 'orchestration',
        message: 'CHAT_REQUIRE_VERIFIED_PR=true requires GitHub CLI (`gh`) to verify PR URLs.',
        remediation: 'Install GitHub CLI and ensure it is on PATH for the runtime user.',
        code: 'github_cli_missing_for_pr_verification',
      }),
    );
  }

  if (config.CHAT_DISPATCH_MODE === 'task') {
    const registryFile = path.join(expandedDataDir, 'repos', 'registry.json');
    let hasRepo = false;
    try {
      const raw = fs.readFileSync(registryFile, { encoding: 'utf8' });
      const parsed = JSON.parse(raw) as { repos?: unknown };
      hasRepo = Array.isArray(parsed.repos) && parsed.repos.length > 0;
    } catch {
      hasRepo = false;
    }

    if (!hasRepo) {
      issues.push(
        issue({
          severity: strict ? 'error' : 'warn',
          area: 'orchestration',
          message: 'CHAT_DISPATCH_MODE=task has no registered repositories.',
          remediation: 'Register at least one repo before startup: talonbot repos register --id <id> --path <path> --default true',
          code: 'chat_task_mode_requires_repo',
        }),
      );
    }
  }

  const slackNeedsAppToken =
    config.CHAT_TRANSPORT_PROVIDER === 'legacy' || config.CHAT_TRANSPORT_PROVIDER === 'dual';
  if (
    config.SLACK_ENABLED &&
    (!config.SLACK_BOT_TOKEN || !config.SLACK_SIGNING_SECRET || (slackNeedsAppToken && !config.SLACK_APP_TOKEN))
  ) {
    issues.push(
      issue({
        severity: 'error',
        area: 'transports',
        message: slackNeedsAppToken
          ? 'SLACK_ENABLED=true requires SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET.'
          : 'SLACK_ENABLED=true requires SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in chat-sdk mode.',
        remediation: slackNeedsAppToken
          ? 'Set the three Slack secrets in .env, or disable Slack with SLACK_ENABLED=false.'
          : 'Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in .env, or disable Slack with SLACK_ENABLED=false.',
        code: 'slack_missing_secrets',
      }),
    );
  }

  if (config.DISCORD_ENABLED && !config.DISCORD_TOKEN) {
    issues.push(
      issue({
        severity: 'error',
        area: 'transports',
        message: 'DISCORD_ENABLED=true requires DISCORD_TOKEN.',
        remediation: 'Set DISCORD_TOKEN in .env, or disable Discord with DISCORD_ENABLED=false.',
        code: 'discord_missing_token',
      }),
    );
  }

  if (config.CONTROL_HTTP_PORT === 0) {
    issues.push(
      issue({
        severity: 'warn',
        area: 'control-plane',
        message: 'CONTROL_HTTP_PORT is 0; HTTP will use an ephemeral port only.',
        remediation: 'Set CONTROL_HTTP_PORT to a stable port (for example 8080) if operators need a predictable API endpoint.',
        code: 'ephemeral_control_http_port',
      }),
    );
  }

  const dataDirErr = ensureDirWritable(expandedDataDir);
  if (dataDirErr) {
    issues.push(
      issue({
        severity: 'error',
        area: 'storage',
        message: `DATA_DIR is not writable (${expandedDataDir}): ${dataDirErr}`,
        remediation: `Create and chown the directory for the talonbot user: mkdir -p "${expandedDataDir}" && chown -R $(id -un):$(id -gn) "${expandedDataDir}"`,
        code: 'data_dir_not_writable',
      }),
    );
  }

  const socketDirErr = ensureDirWritable(expandedSocketDir);
  if (socketDirErr) {
    issues.push(
      issue({
        severity: 'error',
        area: 'socket',
        message: `CONTROL_SOCKET_PATH directory is not writable (${expandedSocketDir}): ${socketDirErr}`,
        remediation: `Create and chown socket directory: mkdir -p "${expandedSocketDir}" && chown -R $(id -un):$(id -gn) "${expandedSocketDir}"`,
        code: 'socket_dir_not_writable',
      }),
    );
  }

  if (process.platform !== 'win32') {
    const socketPathBytes = Buffer.byteLength(expandedSocketPath);
    if (socketPathBytes > SOCKET_PATH_MAX_BYTES) {
      issues.push({
        severity: 'error',
        area: 'socket',
        message: `CONTROL_SOCKET_PATH is too long (${socketPathBytes} bytes, max ${SOCKET_PATH_MAX_BYTES}): ${expandedSocketPath}`,
      });
    }
  }

  const worktreeDirErr = ensureDirWritable(expandedWorktreeDir);
  if (worktreeDirErr) {
    issues.push(
      issue({
        severity: 'error',
        area: 'orchestration',
        message: `WORKTREE_ROOT_DIR is not writable (${expandedWorktreeDir}): ${worktreeDirErr}`,
        remediation: `Create and chown worktree root: mkdir -p "${expandedWorktreeDir}" && chown -R $(id -un):$(id -gn) "${expandedWorktreeDir}"`,
        code: 'worktree_root_not_writable',
      }),
    );
  }

  const releaseDirErr = ensureDirWritable(expandedReleaseDir);
  if (releaseDirErr) {
    issues.push(
      issue({
        severity: 'error',
        area: 'release',
        message: `RELEASE_ROOT_DIR is not writable (${expandedReleaseDir}): ${releaseDirErr}`,
        remediation: `Create and chown release root: mkdir -p "${expandedReleaseDir}" && chown -R $(id -un):$(id -gn) "${expandedReleaseDir}"`,
        code: 'release_root_not_writable',
      }),
    );
  }

  const outboxDirErr = ensureDirWritable(expandedOutboxDir);
  if (outboxDirErr) {
    issues.push(
      issue({
        severity: 'error',
        area: 'transports',
        message: `TRANSPORT_OUTBOX_STATE_FILE directory is not writable (${expandedOutboxDir}): ${outboxDirErr}`,
        remediation: `Create and chown outbox directory: mkdir -p "${expandedOutboxDir}" && chown -R $(id -un):$(id -gn) "${expandedOutboxDir}"`,
        code: 'transport_outbox_dir_not_writable',
      }),
    );
  }

  if (config.ENGINE_MODE === 'process') {
    const engineDirErr = ensureDirWritable(expandedEngineDir);
    if (engineDirErr) {
      issues.push(
        issue({
          severity: 'error',
          area: 'engine',
          message: `ENGINE_CWD is not writable (${expandedEngineDir}): ${engineDirErr}`,
          remediation: `Create and chown engine cwd: mkdir -p "${expandedEngineDir}" && chown -R $(id -un):$(id -gn) "${expandedEngineDir}"`,
          code: 'engine_cwd_not_writable',
        }),
      );
    }
  }

  const expectedUser = config.RUNTIME_EXPECTED_USER.trim();
  if (expectedUser) {
    let actualUser = process.env.USER || process.env.LOGNAME || '';
    if (!actualUser) {
      try {
        actualUser = os.userInfo().username;
      } catch {
        actualUser = '';
      }
    }

    if (actualUser && actualUser !== expectedUser) {
      issues.push(
        issue({
          severity: strict ? 'error' : 'warn',
          area: 'runtime',
          message: `Runtime user mismatch. Expected "${expectedUser}" but running as "${actualUser}".`,
          remediation:
            `Run talonbot under user "${expectedUser}" (systemd User=${expectedUser}) or set RUNTIME_EXPECTED_USER=${actualUser} for local development.`,
          code: 'runtime_user_mismatch',
        }),
      );
    }
  }

  if (process.getuid?.() === 0) {
    issues.push(
      issue({
        severity: strict ? 'error' : 'warn',
        area: 'runtime',
        message: 'Running as root; prefer a dedicated non-root user.',
        remediation: 'Set SERVICE_USER to a non-root account and reinstall daemon mode, or run without sudo in local mode.',
        code: strict ? 'running_as_root_strict' : 'running_as_root',
      }),
    );
  }

  return issues;
};

export const validateStartupConfigOrThrow = (config: AppConfig): StartupIssue[] => {
  const issues = validateStartupConfig(config);
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new StartupValidationError(issues);
  }
  return issues;
};
