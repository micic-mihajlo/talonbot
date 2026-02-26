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

type ControlCommand = SendCommand | StopCommand | HealthCommand | ListCommand;

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
