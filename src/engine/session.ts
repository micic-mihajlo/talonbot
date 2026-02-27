import type { AgentEngine, EngineInput, EngineOutput } from './types.js';
import { ProcessEngine } from './process.js';

/**
 * SessionEngine scaffold.
 *
 * Goal: migrate from one-shot process invocations to a persistent session runtime.
 * Current milestone keeps behavior compatible by delegating to ProcessEngine while
 * we wire socket/session-control transport in follow-up commits.
 */
export class SessionEngine implements AgentEngine {
  private readonly fallback: ProcessEngine;

  constructor(command: string, args: string, timeoutMs: number, cwd: string) {
    this.fallback = new ProcessEngine(command, args, timeoutMs, cwd);
  }

  async complete(input: EngineInput, signal?: AbortSignal): Promise<EngineOutput> {
    return this.fallback.complete(input, signal);
  }

  async ping(): Promise<boolean> {
    return this.fallback.ping();
  }
}
