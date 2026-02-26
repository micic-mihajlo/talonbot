import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createLogger } from '../utils/logger';
import { ControlPlane } from '../control';
import type { AppConfig } from '../config';
import { randomUUID } from 'node:crypto';
import type {
  ControlRpcCommand,
  ControlRpcEvent,
  ControlRpcResponse,
  InboundMessage,
} from '../shared/protocol';
import type { Socket } from 'node:net';

interface SendCommand {
  action: 'send';
  source: 'slack' | 'discord';
  channelId: string;
  threadId?: string;
  senderId?: string;
  text: string;
  metadata?: Record<string, string>;
}

interface StopCommand {
  action: 'stop';
  sessionKey: string;
}

interface HealthCommand {
  action: 'health';
}

interface ListCommand {
  action: 'list';
}

interface AliasSetCommand {
  action: 'alias_set';
  alias: string;
  sessionKey: string;
}

interface AliasUnsetCommand {
  action: 'alias_unset';
  alias: string;
}

interface AliasResolveCommand {
  action: 'alias_resolve';
  alias: string;
}

interface AliasListCommand {
  action: 'alias_list';
}

interface LegacyGetMessageCommand {
  action: 'get_message';
  sessionKey: string;
}

interface LegacyGetSummaryCommand {
  action: 'get_summary';
  sessionKey: string;
}

interface LegacyClearCommand {
  action: 'clear';
  sessionKey: string;
  summarize?: boolean;
}

interface LegacyAbortCommand {
  action: 'abort';
  sessionKey: string;
}

type ControlCommand =
  | SendCommand
  | StopCommand
  | HealthCommand
  | ListCommand
  | AliasSetCommand
  | AliasUnsetCommand
  | AliasResolveCommand
  | AliasListCommand
  | LegacyGetMessageCommand
  | LegacyGetSummaryCommand
  | LegacyClearCommand
  | LegacyAbortCommand;

const parseBody = (chunk: string) => JSON.parse(chunk) as ControlCommand;

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

        let payload: unknown;
        try {
          payload = parseBody(line.trim());
        } catch (error) {
          respondParseError(client, `Failed to parse command: ${(error as Error).message}`);
          continue;
        }

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
            const response = await control.handleSessionRpcCommand(rpcCommand as ControlRpcCommand, client);
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

        respondParseError(client, 'Failed to parse command');
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
