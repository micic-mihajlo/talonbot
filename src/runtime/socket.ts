import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { ControlPlane } from '../control/index.js';
import type { AppConfig } from '../config.js';
import { expandPath } from '../utils/path.js';
import { randomUUID } from 'node:crypto';
import type {
  ControlRpcEvent,
  ControlRpcResponse,
  InboundMessage,
} from '../shared/protocol.js';
import type { Socket } from 'node:net';

const SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 103 : 107;

const assertSocketPathLength = (socketPath: string) => {
  if (process.platform === 'win32') {
    return;
  }

  const socketPathBytes = Buffer.byteLength(socketPath);
  if (socketPathBytes > SOCKET_PATH_MAX_BYTES) {
    throw new Error(
      `CONTROL_SOCKET_PATH is too long (${socketPathBytes} bytes, max ${SOCKET_PATH_MAX_BYTES}): ${socketPath}`,
    );
  }
};

const ensureSocketDirectory = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
};

const unlinkIfStaleSocket = (socketPath: string) => {
  if (!fs.existsSync(socketPath)) {
    return;
  }

  const stats = fs.lstatSync(socketPath);
  if (!stats.isSocket()) {
    throw new Error(`CONTROL_SOCKET_PATH already exists and is not a socket: ${socketPath}`);
  }

  fs.unlinkSync(socketPath);
};

const unlinkIfSocket = (socketPath: string) => {
  if (!fs.existsSync(socketPath)) {
    return;
  }

  const stats = fs.lstatSync(socketPath);
  if (stats.isSocket()) {
    fs.unlinkSync(socketPath);
  }
};

const waitForSocketServerListen = (server: net.Server, socketPath: string) =>
  new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(socketPath);
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error as Error);
    }
  });

const writeResponse = (socket: Socket, response: ControlRpcResponse | ControlRpcEvent | Record<string, unknown>) => {
  try {
    socket.write(`${JSON.stringify(response)}\n`);
  } catch {
    // ignore if socket closes while we are writing
  }
};

const resolveSessionKey = (control: ControlPlane, sessionKey?: string) => {
  if (!sessionKey) {
    return undefined;
  }

  const trimmed = sessionKey.trim();
  if (!trimmed) {
    return undefined;
  }

  const alias = control.resolveAlias(trimmed);
  return alias?.sessionKey ?? trimmed;
};

const respondParseError = (socket: Socket, message: string, command?: string, id?: string) => {
  writeResponse(socket, {
    type: 'response',
    command: command ?? 'parse',
    success: false,
    error: message,
    id,
  });
};

const randomId = () => `socket-${Date.now()}-${randomUUID().slice(0, 8)}`;
const MAX_CONTROL_PAYLOAD_BYTES = 1_000_000;

export interface SocketServerHandle {
  close: () => Promise<void>;
}

export const createSocketServer = async (
  control: ControlPlane,
  config: AppConfig,
  logger = createLogger('runtime.socket', 'info'),
): Promise<SocketServerHandle> => {
  const socketPath = expandPath(config.CONTROL_SOCKET_PATH);
  const dir = path.dirname(socketPath);

  assertSocketPathLength(socketPath);
  try {
    ensureSocketDirectory(dir);
    unlinkIfStaleSocket(socketPath);
  } catch (error) {
    throw new Error(`Failed to prepare control socket at ${socketPath}: ${(error as Error).message}`);
  }

  const server = net.createServer((client) => {
    let buffer = '';

    client.setEncoding('utf8');

    client.on('data', async (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString();
      if (buffer.length > MAX_CONTROL_PAYLOAD_BYTES) {
        respondParseError(client, 'Failed to parse command: message too large');
        buffer = '';
        return;
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        try {
          const payload = JSON.parse(line.trim()) as unknown;
          const rpcCommand = control.parseControlRpc(payload);

          if (rpcCommand) {
            const resolvedSessionKey = resolveSessionKey(control, rpcCommand.sessionKey);
            if (!resolvedSessionKey) {
              const id = 'id' in rpcCommand && typeof rpcCommand.id === 'string' ? rpcCommand.id : undefined;
              writeResponse(client, {
                type: 'response',
                command: rpcCommand.type,
                success: false,
                error: 'sessionKey required',
                id,
              });
              continue;
            }

            rpcCommand.sessionKey = resolvedSessionKey;
            const response = await control.handleSessionRpcCommand(resolvedSessionKey, rpcCommand, client);
            writeResponse(client, response);
            continue;
          }

          const legacyCommand = control.parseLegacyCommand(payload);
          if (legacyCommand) {
            if (legacyCommand.action === 'send') {
              if (!legacyCommand.source || !legacyCommand.channelId || !legacyCommand.text) {
                writeResponse(client, { accepted: false, error: 'source, channelId and text required' });
                continue;
              }

              const inbound: InboundMessage = {
                id: randomId(),
                source: legacyCommand.source,
                sourceChannelId: legacyCommand.channelId,
                sourceThreadId: legacyCommand.threadId,
                senderId: legacyCommand.senderId || 'socket',
                senderName: 'socket',
                senderIsBot: false,
                text: legacyCommand.text,
                mentionsBot: true,
                attachments: [],
                metadata: legacyCommand.metadata || {},
                receivedAt: new Date().toISOString(),
              };

              const result = await control.dispatch(inbound, {
                reply: async () => {},
              });

              writeResponse(client, { accepted: result.accepted, reason: result.reason, sessionKey: result.sessionKey });
              continue;
            }

            const resolved = await control.handleLegacySocketCommand(legacyCommand);
            writeResponse(client, resolved);
            continue;
          }

          if (payload && typeof payload === 'object' && 'type' in payload) {
            const parsedType = (payload as { type?: unknown }).type;
            if (typeof parsedType !== 'string') {
              respondParseError(client, 'Failed to parse command: Missing command type');
              continue;
            }
          }
          if (payload && typeof payload === 'object' && !('type' in payload)) {
            respondParseError(
              client,
              'Failed to parse command: Missing command type',
            );
            continue;
          }

          respondParseError(client, 'Failed to parse command');
        } catch (error) {
          respondParseError(client, `Failed to parse command: ${(error as Error).message}`);
          continue;
        }
      }
    });

    client.on('error', (error) => {
      logger.error('socket client error', error);
    });
  });

  await waitForSocketServerListen(server, socketPath);

  server.on('error', (error) => {
    logger.error('socket server error', error);
  });

  try {
    fs.chmodSync(socketPath, 0o600);
  } catch {
    // fallback to OS default permissions when chmod fails
  }

  let closed = false;

  return {
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });

      try {
        unlinkIfSocket(socketPath);
      } catch (error) {
        logger.warn(`failed to cleanup control socket at ${socketPath}: ${(error as Error).message}`);
      }
    },
  };
};
