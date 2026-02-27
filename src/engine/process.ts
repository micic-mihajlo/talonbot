import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { AgentEngine, EngineInput, EngineOutput } from './types.js';
import { Logger } from '../utils/logger.js';
import { expandPath } from '../utils/path.js';

const ENGINE_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TZ',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'XAI_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZAI_API_KEY',
  'MISTRAL_API_KEY',
  'MINIMAX_API_KEY',
  'KIMI_API_KEY',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'PI_CODING_AGENT_DIR',
  'PI_PACKAGE_DIR',
  'PI_OFFLINE',
  'PI_SHARE_VIEWER_URL',
  'PI_AI_ANTIGRAVITY_VERSION',
] as const;

const buildEngineEnv = (input: EngineInput, cwd: string): NodeJS.ProcessEnv => {
  const base: NodeJS.ProcessEnv = {
    TALONBOT_SESSION: input.sessionKey,
    TALONBOT_ROUTE: input.route,
    PWD: cwd,
  };

  for (const key of ENGINE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      base[key] = value;
    }
  }

  return base;
};

const splitCommand = (command: string, args: string) => {
  const parsed = args && args.trim().length > 0
    ? args
        .trim()
        .match(/(?:"[^"]*"|[^\s"]+)/g)
        ?.map((value) => value.replace(/^"(.*)"$/, '$1')) ?? []
    : [];
  return [command, ...parsed];
};

interface ExecFailureDetails {
  message: string;
  code?: number | string;
  signal?: string | null;
  timedOut: boolean;
  stdout?: string;
  stderr?: string;
}

interface ExecSuccess {
  stdout: string;
  stderr: string;
}

interface ExecOptions {
  timeoutMs: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

const runProcess = (cmd: string, args: string[], options: ExecOptions): Promise<ExecSuccess> =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    // pi can wait for stdin in some modes; close immediately for one-shot turn execution.
    child.stdin.end();

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, options.timeoutMs);

    const abortHandler = () => {
      child.kill('SIGTERM');
    };

    options.signal?.addEventListener('abort', abortHandler, { once: true });

    child.on('error', (error) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortHandler);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortHandler);

      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const details: ExecFailureDetails = {
        message: `Command failed: ${cmd} ${args.join(' ')}`,
        code: code ?? undefined,
        signal,
        timedOut,
        stdout: stdout.trim() || undefined,
        stderr: stderr.trim() || undefined,
      };

      reject(details);
    });
  });

export class ProcessEngine implements AgentEngine {
  private readonly logger = new Logger('engine.process');
  private readonly cwd: string;

  constructor(
    private readonly command = 'pi',
    private readonly args = '',
    private readonly timeoutMs = 120000,
    cwd = '',
  ) {
    this.cwd = expandPath(cwd || process.cwd());
  }

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
    await fs.mkdir(this.cwd, { recursive: true });

    let stdout = '';
    try {
      const result = await runProcess(cmd, [...cmdArgs, payload], {
        cwd: this.cwd,
        timeoutMs: this.timeoutMs,
        signal,
        env: buildEngineEnv(input, this.cwd),
      });
      stdout = result.stdout;
    } catch (error) {
      const details = (error && typeof error === 'object' ? error : { message: String(error), timedOut: false }) as ExecFailureDetails;
      this.logger.error('engine process invocation failed', {
        sessionKey: input.sessionKey,
        route: input.route,
        command: cmd,
        args: cmdArgs,
        timeoutMs: this.timeoutMs,
        cwd: this.cwd,
        payloadBytes: Buffer.byteLength(payload, 'utf8'),
        ...details,
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
