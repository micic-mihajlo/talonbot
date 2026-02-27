import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { expandPath } from './path.js';

export interface StartupIssue {
  severity: 'warn' | 'error';
  area: string;
  message: string;
}

const ensureDirWritable = (targetPath: string): string | null => {
  try {
    fs.mkdirSync(targetPath, { recursive: true });
    fs.accessSync(targetPath, fs.constants.F_OK | fs.constants.R_OK | fs.constants.W_OK);
    return null;
  } catch (error) {
    const reason = (error as Error).message;
    return reason;
  }
};

const SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 103 : 107;

export const validateStartupConfig = (config: AppConfig): StartupIssue[] => {
  const issues: StartupIssue[] = [];

  const expandedDataDir = expandPath(config.DATA_DIR);
  const expandedSocketPath = expandPath(config.CONTROL_SOCKET_PATH);
  const expandedSocketDir = path.dirname(expandedSocketPath);
  const expandedWorktreeDir = expandPath(config.WORKTREE_ROOT_DIR);
  const expandedReleaseDir = expandPath(config.RELEASE_ROOT_DIR);
  const expandedEngineDir = expandPath(config.ENGINE_CWD);

  if (!config.CONTROL_AUTH_TOKEN) {
    issues.push({
      severity: 'warn',
      area: 'control-plane',
      message: 'CONTROL_AUTH_TOKEN is empty; HTTP/socket control endpoints are unauthenticated.',
    });
  } else if (config.CONTROL_AUTH_TOKEN.length < 24) {
    issues.push({
      severity: 'warn',
      area: 'control-plane',
      message: 'CONTROL_AUTH_TOKEN is short; use at least 24 characters.',
    });
  }

  if (config.ENGINE_MODE === 'process' && !config.ENGINE_COMMAND.trim()) {
    issues.push({
      severity: 'error',
      area: 'engine',
      message: 'ENGINE_MODE=process requires ENGINE_COMMAND to be set.',
    });
  }

  if (config.TASK_AUTO_PR && !config.TASK_AUTO_COMMIT) {
    issues.push({
      severity: 'warn',
      area: 'orchestration',
      message: 'TASK_AUTO_PR=true without TASK_AUTO_COMMIT=true will skip PR creation.',
    });
  }

  if (!config.DISCORD_ENABLED && !config.SLACK_ENABLED) {
    issues.push({
      severity: 'warn',
      area: 'transports',
      message: 'No chat transport enabled; only control-plane APIs will be available.',
    });
  }

  if (config.CONTROL_HTTP_PORT === 0) {
    issues.push({
      severity: 'warn',
      area: 'control-plane',
      message: 'CONTROL_HTTP_PORT is 0; HTTP will use an ephemeral port only.',
    });
  }

  const dataDirErr = ensureDirWritable(expandedDataDir);
  if (dataDirErr) {
    issues.push({
      severity: 'error',
      area: 'storage',
      message: `DATA_DIR is not writable (${expandedDataDir}): ${dataDirErr}`,
    });
  }

  const socketDirErr = ensureDirWritable(expandedSocketDir);
  if (socketDirErr) {
    issues.push({
      severity: 'error',
      area: 'socket',
      message: `CONTROL_SOCKET_PATH directory is not writable (${expandedSocketDir}): ${socketDirErr}`,
    });
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
    issues.push({
      severity: 'error',
      area: 'orchestration',
      message: `WORKTREE_ROOT_DIR is not writable (${expandedWorktreeDir}): ${worktreeDirErr}`,
    });
  }

  const releaseDirErr = ensureDirWritable(expandedReleaseDir);
  if (releaseDirErr) {
    issues.push({
      severity: 'error',
      area: 'release',
      message: `RELEASE_ROOT_DIR is not writable (${expandedReleaseDir}): ${releaseDirErr}`,
    });
  }

  if (config.ENGINE_MODE === 'process') {
    const engineDirErr = ensureDirWritable(expandedEngineDir);
    if (engineDirErr) {
      issues.push({
        severity: 'error',
        area: 'engine',
        message: `ENGINE_CWD is not writable (${expandedEngineDir}): ${engineDirErr}`,
      });
    }
  }

  if (process.getuid?.() === 0) {
    issues.push({
      severity: 'warn',
      area: 'runtime',
      message: 'Running as root; prefer a dedicated non-root user.',
    });
  }

  return issues;
};
