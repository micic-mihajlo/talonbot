import type { AppConfig } from '../config.js';
import type { AgentEngine } from './types.js';
import { MockEngine } from './mock.js';
import { ProcessEngine } from './process.js';
import { SessionEngine } from './session.js';

export const buildEngine = (config: AppConfig): AgentEngine => {
  if (config.ENGINE_MODE === 'mock') {
    return new MockEngine();
  }

  if (config.ENGINE_MODE === 'session') {
    return new SessionEngine(config.ENGINE_COMMAND, config.ENGINE_ARGS, config.ENGINE_TIMEOUT_MS, config.ENGINE_CWD);
  }

  return new ProcessEngine(config.ENGINE_COMMAND, config.ENGINE_ARGS, config.ENGINE_TIMEOUT_MS, config.ENGINE_CWD);
};
