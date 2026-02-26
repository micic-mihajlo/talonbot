import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createLogger } from '../utils/logger';
import { ControlPlane } from '../control';
import type { AppConfig } from '../config';
import type { InboundMessage } from '../shared/protocol';
import crypto from 'node:crypto';

const randomId = () => `sock-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

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

type ControlCommand =
  | SendCommand
  | StopCommand
  | HealthCommand
  | ListCommand
  | AliasSetCommand
  | AliasUnsetCommand
  | AliasResolveCommand
  | AliasListCommand;

const parseBody = (chunk: string) => {
  return JSON.parse(chunk) as ControlCommand;
};

const safeSocketPath = (rawPath: string, home: string) => rawPath.replace('~', home);

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
        if (!line.trim()) continue;

        try {
        const command = parseBody(line.trim());
        if (command.action === 'health') {
          client.write(JSON.stringify({ healthy: true, sessions: control.listSessions() }) + '\n');
          continue;
        }

        if (command.action === 'alias_list') {
          client.write(JSON.stringify({ aliases: control.listAliases() }) + '\n');
          continue;
        }

        if (command.action === 'alias_resolve') {
          const alias = control.resolveAlias(command.alias);
          if (!alias) {
            client.write(JSON.stringify({ error: 'alias_not_found' }) + '\n');
            continue;
          }
          client.write(JSON.stringify({ alias: alias.alias, sessionKey: alias.sessionKey }) + '\n');
          continue;
        }

        if (command.action === 'alias_set') {
          if (!command.alias || !command.sessionKey) {
            client.write(JSON.stringify({ error: 'alias and sessionKey required' }) + '\n');
            continue;
          }
          await control.setAlias(command.alias, command.sessionKey);
          client.write(JSON.stringify({ alias: command.alias, sessionKey: command.sessionKey }) + '\n');
          continue;
        }

        if (command.action === 'alias_unset') {
          if (!command.alias) {
            client.write(JSON.stringify({ error: 'alias required' }) + '\n');
            continue;
          }
          const previous = await control.removeAlias(command.alias);
          if (!previous) {
            client.write(JSON.stringify({ error: 'alias_not_found' }) + '\n');
            continue;
          }
          client.write(JSON.stringify({ alias: command.alias, removed: true }) + '\n');
          continue;
        }

          if (command.action === 'list') {
            client.write(JSON.stringify({ sessions: control.listSessions() }) + '\n');
            continue;
          }

        if (command.action === 'stop') {
          const success = await control.stopSession(command.sessionKey);
          client.write(JSON.stringify({ stopped: success }) + '\n');
          continue;
        }

          if (command.action === 'send') {
            const inbound: InboundMessage = {
              id: randomId(),
              source: command.source,
              sourceChannelId: command.channelId,
              sourceThreadId: command.threadId,
              senderId: command.senderId || 'socket',
              text: command.text,
              mentionsBot: true,
              attachments: [],
              metadata: command.metadata || {},
              receivedAt: new Date().toISOString(),
            };
            const result = await control.dispatch(inbound, {
              reply: async () => {},
            });

            client.write(JSON.stringify({ accepted: result.accepted, reason: result.reason, sessionKey: result.sessionKey }) + '\n');
            continue;
          }

          client.write(JSON.stringify({ error: 'unknown_action' }) + '\n');
        } catch (error) {
          client.write(JSON.stringify({ error: (error as Error).message }) + '\n');
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
