import type { AppConfig } from '../config';
import type { AgentEngine } from './types';
import { MockEngine } from './mock';
import { ProcessEngine } from './process';

export const buildEngine = (config: AppConfig): AgentEngine => {
  if (config.ENGINE_MODE === 'mock') {
    return new MockEngine();
  }

  return new ProcessEngine(config.ENGINE_COMMAND, config.ENGINE_ARGS, config.ENGINE_TIMEOUT_MS);
};
