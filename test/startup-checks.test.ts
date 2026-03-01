import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { StartupValidationError, formatStartupIssue, validateStartupConfig, validateStartupConfigOrThrow } from '../src/utils/startup.js';
import { config as defaultConfig } from '../src/config.js';

const tempPath = (suffix: string) => path.join('/tmp', `talonbot-check-${suffix}-${Math.random().toString(36).slice(2, 7)}`);

describe('startup validation', () => {
  it('warns when CONTROL_AUTH_TOKEN is missing', () => {
    const issues = validateStartupConfig({
      ...defaultConfig,
      CONTROL_AUTH_TOKEN: '',
      DATA_DIR: '/tmp/talonbot-check-data',
      CONTROL_SOCKET_PATH: '/tmp/talonbot-check.sock',
    });

    const issue = issues.find((entry) => entry.area === 'control-plane' && entry.code === 'missing_control_auth_token');
    expect(issue?.severity).toBe('warn');
    expect(issue?.remediation?.length).toBeGreaterThan(10);
    expect(issue ? formatStartupIssue(issue) : '').toContain('Remediation:');
  });

  it('warns when secret command backend is enabled', () => {
    const issues = validateStartupConfig({
      ...defaultConfig,
      TALONBOT_SECRET_ALLOW_COMMAND: true,
      DATA_DIR: '/tmp/talonbot-check-data',
      CONTROL_SOCKET_PATH: '/tmp/talonbot-check.sock',
    });

    const issue = issues.find((entry) => entry.code === 'secret_command_backend_enabled');
    expect(issue?.severity).toBe('warn');
  });

  it('errors when process mode has empty command', () => {
    const issues = validateStartupConfig({
      ...defaultConfig,
      ENGINE_MODE: 'process',
      ENGINE_COMMAND: '',
      DATA_DIR: tempPath('data'),
      CONTROL_SOCKET_PATH: `${tempPath('socket')}.sock`,
    });

    const issue = issues.find((entry) => entry.code === 'missing_engine_command');
    expect(issue?.severity).toBe('error');
  });

  it('errors when process mode command is not available on path', () => {
    const issues = validateStartupConfig({
      ...defaultConfig,
      ENGINE_MODE: 'process',
      ENGINE_COMMAND: 'talonbot-command-that-does-not-exist',
      DATA_DIR: tempPath('data'),
      CONTROL_SOCKET_PATH: `${tempPath('socket')}.sock`,
      ENGINE_CWD: tempPath('engine'),
    });

    const issue = issues.find((entry) => entry.code === 'engine_command_not_found');
    expect(issue?.severity).toBe('error');
  });

  it('errors when slack is enabled without required tokens', () => {
    const issues = validateStartupConfig({
      ...defaultConfig,
      ENGINE_MODE: 'mock',
      SLACK_ENABLED: true,
      SLACK_BOT_TOKEN: '',
      SLACK_APP_TOKEN: '',
      SLACK_SIGNING_SECRET: '',
      DATA_DIR: tempPath('data'),
      CONTROL_SOCKET_PATH: `${tempPath('socket')}.sock`,
    });

    const issue = issues.find((entry) => entry.code === 'slack_missing_secrets');
    expect(issue?.severity).toBe('error');
  });

  it('errors when discord is enabled without token', () => {
    const issues = validateStartupConfig({
      ...defaultConfig,
      ENGINE_MODE: 'mock',
      DISCORD_ENABLED: true,
      DISCORD_TOKEN: '',
      DATA_DIR: tempPath('data'),
      CONTROL_SOCKET_PATH: `${tempPath('socket')}.sock`,
    });

    const issue = issues.find((entry) => entry.code === 'discord_missing_token');
    expect(issue?.severity).toBe('error');
  });

  it('errors when CONTROL_SOCKET_PATH is longer than unix socket limits', () => {
    const issues = validateStartupConfig({
      ...defaultConfig,
      CONTROL_AUTH_TOKEN: 'startup-check-token-very-long-123456',
      DATA_DIR: '/tmp/talonbot-check-data',
      CONTROL_SOCKET_PATH: path.join('/tmp', `talonbot-${'x'.repeat(140)}`, 'control.sock'),
    });

    expect(
      issues.some(
        (issue) => issue.area === 'socket' && issue.severity === 'error' && issue.message.includes('too long'),
      ),
    ).toBe(true);
  });

  it('errors in strict mode when task-first chat has no registered repos', () => {
    const issues = validateStartupConfig({
      ...defaultConfig,
      ENGINE_MODE: 'mock',
      STARTUP_INTEGRITY_MODE: 'strict',
      CHAT_DISPATCH_MODE: 'task',
      CHAT_REQUIRE_VERIFIED_PR: false,
      DATA_DIR: tempPath('data'),
      CONTROL_SOCKET_PATH: `${tempPath('socket')}.sock`,
    });

    const issue = issues.find((entry) => entry.code === 'chat_task_mode_requires_repo');
    expect(issue?.severity).toBe('error');
  });

  it('fails fast when startup validation includes errors', () => {
    const input = {
      ...defaultConfig,
      ENGINE_MODE: 'process',
      ENGINE_COMMAND: '',
      DATA_DIR: tempPath('data'),
      CONTROL_SOCKET_PATH: `${tempPath('socket')}.sock`,
      ENGINE_CWD: tempPath('engine'),
    };

    let thrown: unknown;
    try {
      validateStartupConfigOrThrow(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StartupValidationError);
    expect((thrown as StartupValidationError).issues.some((issue) => issue.code === 'missing_engine_command')).toBe(true);
  });
});
