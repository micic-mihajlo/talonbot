import fs from 'node:fs';
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

  const expandedDataDir = expandPath(config.DATA_DIR);
  const expandedSocketPath = expandPath(config.CONTROL_SOCKET_PATH);
  const expandedSocketDir = path.dirname(expandedSocketPath);
  const expandedWorktreeDir = expandPath(config.WORKTREE_ROOT_DIR);
  const expandedReleaseDir = expandPath(config.RELEASE_ROOT_DIR);
  const expandedEngineDir = expandPath(config.ENGINE_CWD);

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

  if (config.SLACK_ENABLED && (!config.SLACK_BOT_TOKEN || !config.SLACK_APP_TOKEN || !config.SLACK_SIGNING_SECRET)) {
    issues.push(
      issue({
        severity: 'error',
        area: 'transports',
        message: 'SLACK_ENABLED=true requires SLACK_BOT_TOKEN, SLACK_APP_TOKEN, and SLACK_SIGNING_SECRET.',
        remediation: 'Set the three Slack secrets in .env, or disable Slack with SLACK_ENABLED=false.',
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

  if (process.getuid?.() === 0) {
    issues.push(
      issue({
        severity: 'warn',
        area: 'runtime',
        message: 'Running as root; prefer a dedicated non-root user.',
        remediation: 'Set SERVICE_USER to a non-root account and reinstall daemon mode, or run without sudo in local mode.',
        code: 'running_as_root',
      }),
    );
  }

  return issues;
};
