import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { validateStartupConfig } from '../src/utils/startup.js';
import { config as defaultConfig } from '../src/config.js';

describe('startup validation', () => {
  it('warns when CONTROL_AUTH_TOKEN is missing', () => {
    const issues = validateStartupConfig({
      ...defaultConfig,
      CONTROL_AUTH_TOKEN: '',
      DATA_DIR: '/tmp/talonbot-check-data',
      CONTROL_SOCKET_PATH: '/tmp/talonbot-check.sock',
    });

    expect(issues.some((issue) => issue.area === 'control-plane' && issue.severity === 'warn')).toBe(true);
  });

  it('errors when process mode has empty command', () => {
    const issues = validateStartupConfig({
      ...defaultConfig,
      ENGINE_MODE: 'process',
      ENGINE_COMMAND: '',
      DATA_DIR: path.join('/tmp', `talonbot-check-${Math.random().toString(36).slice(2, 6)}`),
      CONTROL_SOCKET_PATH: path.join('/tmp', `talonbot-check-${Math.random().toString(36).slice(2, 6)}.sock`),
    });

    expect(issues.some((issue) => issue.area === 'engine' && issue.severity === 'error')).toBe(true);
  });
});

