import { describe, expect, it } from 'vitest';

import { parseAppConfig } from '../src/config.js';

describe('config schema', () => {
  it('parses defaults and normalizes allowlists', () => {
    const parsed = parseAppConfig(
      {
        SLACK_ALLOWED_USERS: 'alice, bob ,carol',
        DISCORD_ALLOWED_CHANNELS: 'core,ops',
      } as NodeJS.ProcessEnv,
      {},
    );

    expect(parsed.SLACK_ALLOWED_USERS).toEqual(['alice', 'bob', 'carol']);
    expect(parsed.DISCORD_ALLOWED_CHANNELS).toEqual(['core', 'ops']);
    expect(parsed.ENGINE_MODE).toBe('process');
  });

  it('fails on unknown keys found in .env', () => {
    expect(() =>
      parseAppConfig({} as NodeJS.ProcessEnv, {
        CONTROL_HTTP_PORT: '8080',
        CONTROL_HTTP_PRT: '9999',
      }),
    ).toThrow(/CONTROL_HTTP_PRT/);
  });

  it('fails when a boolean env uses an invalid value', () => {
    expect(() => parseAppConfig({ SLACK_ENABLED: 'maybe' } as NodeJS.ProcessEnv, {})).toThrow(/SLACK_ENABLED/);
  });

  it('fails when Slack is enabled without required credentials', () => {
    expect(() => parseAppConfig({ SLACK_ENABLED: 'true' } as NodeJS.ProcessEnv, {})).toThrow(/SLACK_BOT_TOKEN/);
  });

  it('fails when TASK_AUTO_PR is enabled without auto-commit', () => {
    expect(() => parseAppConfig({ TASK_AUTO_PR: 'true', TASK_AUTO_COMMIT: 'false' } as NodeJS.ProcessEnv, {})).toThrow(
      /TASK_AUTO_COMMIT/,
    );
  });
});
