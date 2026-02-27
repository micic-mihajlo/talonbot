import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { AgentEngine, EngineInput, EngineOutput } from './types.js';
import { createLogger } from '../utils/logger.js';
import { expandPath } from '../utils/path.js';

interface RpcMessage {
  type?: string;
  command?: string;
  event?: string;
  success?: boolean;
  error?: string;
  id?: string;
  data?: unknown;
}

interface PendingResponse {
  resolve: (value: RpcMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

type SocketConnector = (options: net.NetConnectOpts) => net.Socket;

const randomId = (prefix: string) => `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}`;

const parseMessageContent = (message: RpcMessage): string => {
  const data = message.data;
  if (!data || typeof data !== 'object') {
    throw new Error('session_engine_missing_message');
  }

  const payload = data as { message?: { content?: unknown } | null };
  const content = payload.message?.content;
  if (typeof content !== 'string') {
    throw new Error('session_engine_missing_message');
  }

  return content;
};

export class SessionEngine implements AgentEngine {
  private readonly logger = createLogger('engine.session', 'info');
  private readonly socketPath: string;

  constructor(
    socketPath: string,
    private readonly timeoutMs = 120000,
    private readonly maxAttempts = 2,
    private readonly connectSocket: SocketConnector = (options) => net.createConnection(options),
  ) {
    this.socketPath = expandPath(socketPath);
  }

  async complete(input: EngineInput, signal?: AbortSignal): Promise<EngineOutput> {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      try {
        return await this.completeViaSocket(input, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw new Error('session_engine_aborted');
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn('session engine turn attempt failed', {
          sessionKey: input.sessionKey,
          route: input.route,
          attempt,
          maxAttempts: this.maxAttempts,
          error: lastError.message,
        });
      }
    }

    throw lastError || new Error('session_engine_failed');
  }

  async ping(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = this.connectSocket({ path: this.socketPath });
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, Math.min(5000, this.timeoutMs));

      socket.once('connect', () => {
        clearTimeout(timeout);
        socket.end();
        resolve(true);
      });

      socket.once('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  private completeViaSocket(input: EngineInput, signal?: AbortSignal): Promise<EngineOutput> {
    return new Promise<EngineOutput>((resolve, reject) => {
      const socket = this.connectSocket({ path: this.socketPath });
      socket.setEncoding('utf8');

      const pending = new Map<string, PendingResponse>();
      let waitTurnEnd: { resolve: () => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> } | null = null;
      let settled = false;
      let buffer = '';

      const completeTimer = setTimeout(() => {
        finish(new Error('session_engine_timeout'));
      }, this.timeoutMs);

      const clearPending = () => {
        for (const state of pending.values()) {
          clearTimeout(state.timeout);
        }
        pending.clear();
        if (waitTurnEnd) {
          clearTimeout(waitTurnEnd.timeout);
          waitTurnEnd = null;
        }
      };

      const finish = (error?: Error, output?: EngineOutput) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(completeTimer);
        clearPending();
        socket.removeAllListeners();
        socket.end();
        if (error) {
          reject(error);
          return;
        }
        resolve(output || { text: '' });
      };

      const failPending = (error: Error) => {
        for (const state of pending.values()) {
          clearTimeout(state.timeout);
          state.reject(error);
        }
        pending.clear();
      };

      const failTurnEnd = (error: Error) => {
        if (!waitTurnEnd) {
          return;
        }
        clearTimeout(waitTurnEnd.timeout);
        waitTurnEnd.reject(error);
        waitTurnEnd = null;
      };

      const waitResponse = (id: string) =>
        new Promise<RpcMessage>((responseResolve, responseReject) => {
          const timeout = setTimeout(() => {
            pending.delete(id);
            responseReject(new Error(`session_engine_response_timeout:${id}`));
          }, this.timeoutMs);

          pending.set(id, {
            resolve: (message) => {
              clearTimeout(timeout);
              pending.delete(id);
              responseResolve(message);
            },
            reject: (error) => {
              clearTimeout(timeout);
              pending.delete(id);
              responseReject(error);
            },
            timeout,
          });
        });

      const waitForTurnEnd = () =>
        new Promise<void>((turnResolve, turnReject) => {
          const timeout = setTimeout(() => {
            if (waitTurnEnd) {
              waitTurnEnd = null;
            }
            turnReject(new Error('session_engine_turn_end_timeout'));
          }, this.timeoutMs);

          waitTurnEnd = {
            resolve: () => {
              clearTimeout(timeout);
              waitTurnEnd = null;
              turnResolve();
            },
            reject: (error) => {
              clearTimeout(timeout);
              waitTurnEnd = null;
              turnReject(error);
            },
            timeout,
          };
        });

      const sendCommand = (command: Record<string, unknown>) => {
        try {
          socket.write(`${JSON.stringify(command)}\n`);
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error));
        }
      };

      const consume = (raw: string) => {
        const parsed = JSON.parse(raw) as RpcMessage;
        if (parsed.type === 'response' && parsed.id) {
          const state = pending.get(parsed.id);
          if (state) {
            state.resolve(parsed);
            return;
          }
        }

        if (parsed.type === 'event' && parsed.event === 'turn_end' && waitTurnEnd) {
          waitTurnEnd.resolve();
        }
      };

      const handleError = (err: unknown) => {
        if (settled) {
          return;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        failPending(error);
        failTurnEnd(error);
        finish(error);
      };

      socket.once('connect', () => {
        const subscribeId = randomId('session-sub');
        const sendId = randomId('session-send');
        const getMessageId = randomId('session-get-message');

        const subscribeResponse = waitResponse(subscribeId);
        const sendResponse = waitResponse(sendId);
        const turnEnd = waitForTurnEnd();

        try {
          sendCommand({
            type: 'subscribe',
            event: 'turn_end',
            id: subscribeId,
            sessionKey: input.sessionKey,
          });

          sendCommand({
            type: 'send',
            id: sendId,
            sessionKey: input.sessionKey,
            message: input.text,
            mode: 'follow_up',
          });
        } catch (error) {
          handleError(error);
          return;
        }

        void (async () => {
          const sub = await subscribeResponse;
          if (!sub.success) {
            throw new Error(sub.error || 'session_engine_subscribe_failed');
          }

          const sent = await sendResponse;
          if (!sent.success) {
            throw new Error(sent.error || 'session_engine_send_failed');
          }

          await turnEnd;

          const getResponse = waitResponse(getMessageId);
          sendCommand({
            type: 'get_message',
            id: getMessageId,
            sessionKey: input.sessionKey,
          });

          const message = await getResponse;
          if (!message.success) {
            throw new Error(message.error || 'session_engine_get_message_failed');
          }

          const content = parseMessageContent(message);
          finish(undefined, { text: content });
        })().catch((error) => {
          handleError(error);
        });
      });

      socket.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          try {
            consume(trimmed);
          } catch (error) {
            handleError(error);
            return;
          }
        }
      });

      socket.once('error', (error) => {
        handleError(error);
      });

      socket.once('close', () => {
        if (!settled) {
          handleError(new Error('session_engine_socket_closed'));
        }
      });

      signal?.addEventListener(
        'abort',
        () => {
          handleError(new Error('session_engine_aborted'));
        },
        { once: true },
      );
    });
  }
}
