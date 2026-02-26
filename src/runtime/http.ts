import http from 'node:http';
import crypto from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { ControlPlane } from '../control/index.js';
import type { ControlDispatchPayload } from '../shared/protocol.js';
import type { InboundMessage } from '../shared/protocol.js';
import type { AppConfig } from '../config.js';

const setSecurityHeaders = (res: http.ServerResponse) => {
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('x-content-type-options', 'nosniff');
};

const writeJson = (res: http.ServerResponse, statusCode: number, body: unknown) => {
  setSecurityHeaders(res);
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
};

const readJsonBody = (req: http.IncomingMessage): Promise<unknown> => {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.includes('application/json')) {
      reject(new Error('invalid_content_type'));
      req.resume();
      return;
    }

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
  writeJson(res, 401, { error: 'unauthorized' });
};

const requireAuth = (req: http.IncomingMessage, config: AppConfig, res: http.ServerResponse): boolean => {
  if (!config.CONTROL_AUTH_TOKEN) {
    return true;
  }

  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${config.CONTROL_AUTH_TOKEN}`) {
    unauthorized(res);
    return false;
  }

  return true;
};

export const createHttpServer = (control: ControlPlane, config: AppConfig, port: number, logger = createLogger('runtime.http', 'info')) => {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      writeJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    if (req.url?.startsWith('/health') && req.method === 'GET') {
      const body = {
        status: 'ok',
        uptime: process.uptime(),
        sessions: control.listSessions().length,
      };
      writeJson(res, 200, body);
      return;
    }

    if (req.method === 'GET' && req.url === '/sessions') {
      if (!requireAuth(req, config, res)) return;
      const body = {
        sessions: control.listSessions(),
      };
      writeJson(res, 200, body);
      return;
    }

    if (req.method === 'GET' && req.url === '/aliases') {
      if (!requireAuth(req, config, res)) return;

      writeJson(res, 200, { aliases: control.listAliases() });
      return;
    }

    if (req.method === 'POST' && (req.url === '/dispatch' || req.url === '/send')) {
      if (!requireAuth(req, config, res)) return;

      try {
        const body = (await readJsonBody(req)) as Partial<ControlDispatchPayload>;
        if (typeof body.text !== 'string' || !body.text.trim()) {
          writeJson(res, 400, { error: 'text required' });
          return;
        }

        if (!body.source || (body.source !== 'slack' && body.source !== 'discord')) {
          writeJson(res, 400, { error: 'source must be slack or discord' });
          return;
        }

        if (!body.channelId) {
          writeJson(res, 400, { error: 'channelId required' });
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

        writeJson(res, 200, {
          accepted: result.accepted,
          reason: result.reason,
          sessionKey: result.sessionKey,
        });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/stop') {
      if (!requireAuth(req, config, res)) return;

      try {
        const body = (await readJsonBody(req)) as { sessionKey?: string };
        if (!body.sessionKey) {
          writeJson(res, 400, { error: 'sessionKey required' });
          return;
        }

        const ok = await control.stopSession(body.sessionKey);
        writeJson(res, 200, { stopped: ok });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/alias') {
      if (!requireAuth(req, config, res)) return;

      try {
        const body = (await readJsonBody(req)) as {
          action?: 'set' | 'unset' | 'resolve' | 'list';
          alias?: string;
          sessionKey?: string;
        };

        if (!body.action) {
          writeJson(res, 400, { error: 'action required' });
          return;
        }

        if (body.action === 'list') {
          writeJson(res, 200, { aliases: control.listAliases() });
          return;
        }

        if (!body.alias || body.alias.trim().length === 0) {
          writeJson(res, 400, { error: 'alias required' });
          return;
        }

        if (body.action === 'set') {
          if (!body.sessionKey || body.sessionKey.trim().length === 0) {
            writeJson(res, 400, { error: 'sessionKey required' });
            return;
          }
          await control.setAlias(body.alias, body.sessionKey);
          writeJson(res, 200, { alias: body.alias, sessionKey: body.sessionKey });
          return;
        }

        if (body.action === 'unset') {
          const previous = await control.removeAlias(body.alias);
          if (!previous) {
            writeJson(res, 404, { error: 'alias_not_found' });
            return;
          }
          writeJson(res, 200, { alias: body.alias, removed: true });
          return;
        }

        if (body.action === 'resolve') {
          const alias = control.resolveAlias(body.alias);
          if (!alias) {
            writeJson(res, 404, { error: 'alias_not_found' });
            return;
          }
          writeJson(res, 200, { alias: alias.alias, sessionKey: alias.sessionKey });
          return;
        }

        writeJson(res, 400, { error: 'unsupported action' });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    writeJson(res, 404, { error: 'not found' });
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => {
      const address = server.address();
      const resolvedPort =
        typeof address === 'string' ? address : address ? address.port : port;
      logger.info(`HTTP server listening on ${resolvedPort}`);
      resolve(server);
    });
  });
};
