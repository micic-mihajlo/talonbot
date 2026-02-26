import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createLogger } from '../utils/logger';
import { ControlPlane } from '../control';
import type { AppConfig } from '../config';
import { randomUUID } from 'node:crypto';
import type {
  ControlRpcEvent,
  ControlRpcResponse,
  InboundMessage,
} from '../shared/protocol';
import type { Socket } from 'node:net';

const safeSocketPath = (rawPath: string, home: string) => rawPath.replace('~', home);
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

export const createSocketServer = (control: ControlPlane, config: AppConfig, logger = createLogger('runtime.socket', 'info')) => {
  const socketPath = safeSocketPath(config.CONTROL_SOCKET_PATH, os.homedir());
  const dir = path.dirname(socketPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  const server = net.createServer((client) => {
    let buffer = '';

    client.setEncoding('utf8');

    client.on('data', async (chunk) => {
      buffer += chunk as string;
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
            if (!resolvedSessionKey && rpcCommand.type !== 'send') {
              respondParseError(client, 'sessionKey required', rpcCommand.type, 'id' in rpcCommand ? rpcCommand.id : undefined);
              continue;
            }

            const target = resolvedSessionKey;
            if (target) {
              rpcCommand.sessionKey = target;
              const response = await control.handleSessionRpcCommand(rpcCommand, client);
              writeResponse(client, response);
              continue;
            }

            const id = 'id' in rpcCommand && typeof rpcCommand.id === 'string' ? rpcCommand.id : undefined;
            const response = {
              type: 'response' as const,
              command: rpcCommand.type,
              success: false,
              error: 'sessionKey required',
              id,
            };
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

  server.listen(socketPath);

  return {
    close: () => {
      server.close();
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    },
  };
};
