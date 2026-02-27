import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentEngine, EngineInput, EngineOutput } from './types.js';
import { Logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const splitCommand = (command: string, args: string) => {
  const parsed = args && args.trim().length > 0
    ? args
        .trim()
        .match(/(?:"[^"]*"|[^\s"]+)/g)
        ?.map((value) => value.replace(/^"(.*)"$/, '$1')) ?? []
    : [];
  return [command, ...parsed];
};

export class ProcessEngine implements AgentEngine {
  private readonly logger = new Logger('engine.process');

  constructor(private readonly command = 'pi', private readonly args = '', private readonly timeoutMs = 120000) {}

  async complete(input: EngineInput, signal?: AbortSignal): Promise<EngineOutput> {
    const payload = JSON.stringify({
      kind: 'agent_turn',
      route: input.route,
      session: input.sessionKey,
      sender: input.senderId,
      message: input.text,
      metadata: input.metadata,
      context: input.contextLines,
      attachments: input.recentAttachments,
    });

    const [cmd, ...cmdArgs] = splitCommand(this.command, this.args);

    let stdout = '';

    try {
      const result = await execFileAsync(cmd, [...cmdArgs, payload], {
        timeout: this.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        signal,
        env: {
          ...process.env,
          TALONBOT_SESSION: input.sessionKey,
          TALONBOT_ROUTE: input.route,
        },
      });
      stdout = result.stdout;
    } catch (error) {
      const err = error as Error & {
        code?: string | number;
        signal?: string;
        killed?: boolean;
        stdout?: string;
        stderr?: string;
        cmd?: string;
      };

      this.logger.error('engine process invocation failed', {
        sessionKey: input.sessionKey,
        route: input.route,
        command: cmd,
        args: cmdArgs,
        timeoutMs: this.timeoutMs,
        code: err.code,
        signal: err.signal,
        killed: err.killed,
        cmdline: err.cmd,
        stderr: (err.stderr || '').toString().slice(0, 4000),
        stdout: (err.stdout || '').toString().slice(0, 1000),
        message: err.message,
      });
      throw error;
    }

    const output = stdout.trim();
    if (!output) {
      return { text: `No output from engine for session ${input.sessionKey}.` };
    }

    try {
      const parsed = JSON.parse(output) as { text?: string };
      if (typeof parsed.text === 'string') {
        return { text: parsed.text };
      }
    } catch {
      this.logger.debug('engine output not JSON, returning raw text');
    }

    return { text: output };
  }

  async ping() {
    try {
      await this.complete({
        sessionKey: 'health',
        route: 'health',
        text: 'ping',
        senderId: 'system',
        metadata: {},
        contextLines: [],
        rawEvent: {
          id: 'health',
          source: 'slack',
          sourceChannelId: 'health',
          sourceMessageId: 'health',
          senderId: 'system',
          senderName: 'system',
          senderIsBot: false,
          text: 'health',
          mentionsBot: false,
          attachments: [],
          metadata: {},
          receivedAt: new Date().toISOString(),
        },
        recentAttachments: [],
      });
      return true;
    } catch {
      return false;
    }
  }
}
