import http from 'node:http';
import crypto from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { ControlPlane } from '../control/index.js';
import type { ControlDispatchPayload } from '../shared/protocol.js';
import type { InboundMessage } from '../shared/protocol.js';
import type { AppConfig } from '../config.js';

const readJsonBody = (req: http.IncomingMessage): Promise<unknown> => {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
};

const randomId = () => `http-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

const unauthorized = (res: http.ServerResponse) => {
  res.statusCode = 401;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ error: 'unauthorized' }));
};

export const createHttpServer = (control: ControlPlane, config: AppConfig, port: number, logger = createLogger('runtime.http', 'info')) => {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }

    if (req.url?.startsWith('/health') && req.method === 'GET') {
      const body = {
        status: 'ok',
        uptime: process.uptime(),
        sessions: control.listSessions().length,
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === 'GET' && req.url === '/sessions') {
      const body = {
        sessions: control.listSessions(),
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === 'GET' && req.url === '/aliases') {
      if (config.CONTROL_AUTH_TOKEN) {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${config.CONTROL_AUTH_TOKEN}`) {
          unauthorized(res);
          return;
        }
      }

      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ aliases: control.listAliases() }));
      return;
    }

    if (req.method === 'POST' && (req.url === '/dispatch' || req.url === '/send')) {
      if (config.CONTROL_AUTH_TOKEN) {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${config.CONTROL_AUTH_TOKEN}`) {
          unauthorized(res);
          return;
        }
      }

      try {
        const body = (await readJsonBody(req)) as Partial<ControlDispatchPayload>;
        if (typeof body.text !== 'string' || !body.text.trim()) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'text required' }));
          return;
        }

        if (!body.source || (body.source !== 'slack' && body.source !== 'discord')) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'source must be slack or discord' }));
          return;
        }

        if (!body.channelId) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'channelId required' }));
          return;
        }

        const inbound: InboundMessage = {
          id: randomId(),
          source: body.source,
          sourceChannelId: body.channelId,
          sourceThreadId: body.threadId,
          sourceMessageId: randomId(),
          senderId: body.senderId || body.userId || 'control',
          senderName: 'control',
          senderIsBot: false,
          text: body.text,
          mentionsBot: true,
          attachments: [],
          metadata: body.metadata || {},
          receivedAt: new Date().toISOString(),
        };

        const result = await control.dispatch(inbound, {
          reply: async () => {
            // reply is intentionally dropped for API dispatches
          },
        });

        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          accepted: result.accepted,
          reason: result.reason,
          sessionKey: result.sessionKey,
        }));
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      if (config.CONTROL_AUTH_TOKEN) {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${config.CONTROL_AUTH_TOKEN}`) {
          unauthorized(res);
          return;
        }
      }

      try {
        const body = (await readJsonBody(req)) as { sessionKey?: string };
        if (!body.sessionKey) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'sessionKey required' }));
          return;
        }

        const ok = await control.stopSession(body.sessionKey);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ stopped: ok }));
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/alias') {
      if (config.CONTROL_AUTH_TOKEN) {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${config.CONTROL_AUTH_TOKEN}`) {
          unauthorized(res);
          return;
        }
      }

      try {
        const body = (await readJsonBody(req)) as {
          action?: 'set' | 'unset' | 'resolve' | 'list';
          alias?: string;
          sessionKey?: string;
        };

        if (!body.action) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'action required' }));
          return;
        }

        if (body.action === 'list') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ aliases: control.listAliases() }));
          return;
        }

        if (!body.alias || body.alias.trim().length === 0) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'alias required' }));
          return;
        }

        if (body.action === 'set') {
          if (!body.sessionKey || body.sessionKey.trim().length === 0) {
            res.statusCode = 400;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'sessionKey required' }));
            return;
          }
          await control.setAlias(body.alias, body.sessionKey);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ alias: body.alias, sessionKey: body.sessionKey }));
          return;
        }

        if (body.action === 'unset') {
          const previous = await control.removeAlias(body.alias);
          if (!previous) {
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'alias_not_found' }));
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ alias: body.alias, removed: true }));
          return;
        }

        if (body.action === 'resolve') {
          const alias = control.resolveAlias(body.alias);
          if (!alias) {
            res.statusCode = 404;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: 'alias_not_found' }));
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ alias: alias.alias, sessionKey: alias.sessionKey }));
          return;
        }

        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'unsupported action' }));
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: (error as Error).message }));
      }
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      logger.info(`HTTP server listening on ${port}`);
      resolve(server);
    });
  });
};
