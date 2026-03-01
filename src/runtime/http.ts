import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { ControlPlane } from '../control/index.js';
import type { ControlDispatchPayload } from '../shared/protocol.js';
import type { InboundMessage } from '../shared/protocol.js';
import type { AppConfig } from '../config.js';
import type { TaskOrchestrator } from '../orchestration/task-orchestrator.js';
import type { BridgeSupervisor } from '../bridge/supervisor.js';
import type { ReleaseManager } from '../ops/release-manager.js';
import type { SentryAgent } from '../orchestration/sentry-agent.js';
import { runSecurityAudit } from '../security/audit.js';
import { createDiagnosticsBundle } from '../diagnostics/bundle.js';
import { ensureDir } from '../utils/path.js';

export interface RuntimeServices {
  tasks?: TaskOrchestrator;
  bridge?: BridgeSupervisor;
  release?: ReleaseManager;
  sentry?: SentryAgent;
  diagnosticsOutputDir?: string;
}

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

const bridgeSignature = (req: http.IncomingMessage) => {
  const signature = req.headers['x-bridge-signature'];
  if (Array.isArray(signature)) {
    return signature[0] || '';
  }
  return String(signature || '');
};

const tryExtractTaskRoute = (pathname: string) => {
  const exact = pathname.match(/^\/tasks\/([^/]+)$/);
  if (exact) {
    return { id: decodeURIComponent(exact[1]), action: 'get' as const };
  }

  const action = pathname.match(/^\/tasks\/([^/]+)\/(retry|cancel|report)$/);
  if (action) {
    return {
      id: decodeURIComponent(action[1]),
      action: action[2] as 'retry' | 'cancel' | 'report',
    };
  }

  return null;
};

const tryExtractWorkerRoute = (pathname: string) => {
  const stop = pathname.match(/^\/workers\/([^/]+)\/stop$/);
  if (stop) {
    return {
      session: decodeURIComponent(stop[1]),
      action: 'stop' as const,
    };
  }

  return null;
};

export const createHttpServer = (
  control: ControlPlane,
  config: AppConfig,
  port: number,
  logger = createLogger('runtime.http', 'info'),
  services?: RuntimeServices,
) => {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      writeJson(res, 405, { error: 'Method Not Allowed' });
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${port || 80}`);
    const pathname = url.pathname;

    if (pathname === '/health' && req.method === 'GET') {
      const releaseStatus = services?.release ? await services.release.status().catch(() => null) : null;
      const tasks = services?.tasks?.listTasks() || [];
      const orchestration = services?.tasks ? await services.tasks.getHealthStatus().catch(() => null) : null;
      const doneCount = tasks.filter((task) => task.state === 'done').length;
      const failedCount = tasks.filter((task) => task.state === 'failed').length;
      const runningCount = tasks.filter((task) => task.state === 'running').length;

      const body = {
        status: 'ok',
        uptime: process.uptime(),
        sessions: control.listSessions().length,
        aliases: control.listAliases().length,
        dependencies: {
          tasks: services?.tasks
            ? {
                total: tasks.length,
                running: runningCount,
                done: doneCount,
                failed: failedCount,
                orchestration,
              }
            : null,
          release: releaseStatus
            ? {
                current: releaseStatus.current,
                previous: releaseStatus.previous,
              }
            : null,
          bridge: services?.bridge ? { enabled: true } : { enabled: false },
          sentry: services?.sentry ? services.sentry.getStatus() : null,
        },
      };
      if (services?.bridge) {
        (body.dependencies as any).bridge = {
          enabled: true,
          ...services.bridge.getHealth(),
        };
      }
      writeJson(res, 200, body);
      return;
    }

    if (req.method === 'GET' && pathname === '/status') {
      if (!requireAuth(req, config, res)) return;
      const orchestration = services?.tasks ? await services.tasks.getHealthStatus().catch(() => null) : null;
      writeJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        process: {
          pid: process.pid,
          node: process.version,
        },
        config: {
          dataDir: config.DATA_DIR,
          transport: {
            slack: config.SLACK_ENABLED,
            discord: config.DISCORD_ENABLED,
            controlSocket: config.CONTROL_SOCKET_PATH,
          },
          engineMode: config.ENGINE_MODE,
          taskConcurrency: config.TASK_MAX_CONCURRENCY,
          integrityMode: config.STARTUP_INTEGRITY_MODE,
        },
        sessions: control.listSessions(),
        aliases: control.listAliases(),
        orchestration,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/sessions') {
      if (!requireAuth(req, config, res)) return;
      const body = {
        sessions: control.listSessions(),
      };
      writeJson(res, 200, body);
      return;
    }

    if (req.method === 'GET' && pathname === '/aliases') {
      if (!requireAuth(req, config, res)) return;
      writeJson(res, 200, { aliases: control.listAliases() });
      return;
    }

    if (req.method === 'POST' && (pathname === '/dispatch' || pathname === '/send')) {
      if (!requireAuth(req, config, res)) return;

      try {
        const body = (await readJsonBody(req)) as Partial<ControlDispatchPayload>;
        if (typeof body.text !== 'string' || !body.text.trim()) {
          writeJson(res, 400, { error: 'text required' });
          return;
        }

        const requestedSessionKey = typeof body.sessionKey === 'string' ? body.sessionKey.trim() : '';
        const requestedAlias = typeof body.alias === 'string' ? body.alias.trim() : '';
        if (requestedAlias && requestedSessionKey) {
          writeJson(res, 400, { error: 'provide either alias or sessionKey, not both' });
          return;
        }

        const source = body.source;
        if (source && source !== 'slack' && source !== 'discord' && source !== 'socket') {
          writeJson(res, 400, { error: 'source must be slack, discord, or socket' });
          return;
        }

        let targetSessionKey = '';
        if (requestedAlias) {
          const alias = control.resolveAlias(requestedAlias);
          if (!alias) {
            writeJson(res, 404, { error: 'alias_not_found', alias: requestedAlias });
            return;
          }
          targetSessionKey = alias.sessionKey;
        } else if (requestedSessionKey) {
          targetSessionKey = control.resolveSessionReference(requestedSessionKey) || requestedSessionKey;
        }

        const inboundSource = source || (targetSessionKey ? 'socket' : undefined);
        if (!inboundSource) {
          writeJson(res, 400, { error: 'source required when sessionKey/alias is not provided' });
          return;
        }

        const inboundChannelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
        if (!inboundChannelId && !targetSessionKey) {
          writeJson(res, 400, { error: 'channelId required when sessionKey/alias is not provided' });
          return;
        }

        const inbound: InboundMessage = {
          id: randomId(),
          source: inboundSource,
          sourceChannelId: inboundChannelId || targetSessionKey,
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

        if (targetSessionKey) {
          const routed = await control.dispatchToSession(targetSessionKey, inbound, {
            reply: async () => {
              // reply is intentionally dropped for API dispatches
            },
          });

          if (!routed.accepted) {
            writeJson(res, 400, {
              accepted: false,
              reason: routed.reason || 'session_dispatch_failed',
              sessionKey: targetSessionKey,
            });
            return;
          }

          writeJson(res, 200, {
            accepted: true,
            reason: 'enqueued',
            sessionKey: targetSessionKey,
            mode: 'session',
          });
          logger.info('dispatch routed to session', {
            sessionKey: targetSessionKey,
            source: inbound.source,
            senderId: inbound.senderId,
          });
          return;
        }

        const result = await control.dispatch(inbound, {
          reply: async () => {
            // reply is intentionally dropped for API dispatches
          },
        });

        writeJson(res, 200, {
          accepted: result.accepted,
          reason: result.reason,
          sessionKey: result.sessionKey,
          mode: result.mode,
          taskId: result.taskId,
        });
        logger.info('dispatch accepted', {
          sessionKey: result.sessionKey,
          source: inbound.source,
          channelId: inbound.sourceChannelId,
          senderId: inbound.senderId,
        });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/stop') {
      if (!requireAuth(req, config, res)) return;

      try {
        const body = (await readJsonBody(req)) as { sessionKey?: string };
        if (!body.sessionKey) {
          writeJson(res, 400, { error: 'sessionKey required' });
          return;
        }

        const target = control.resolveSessionReference(body.sessionKey);
        if (!target) {
          writeJson(res, 400, { error: 'sessionKey required' });
          return;
        }

        const ok = await control.stopSession(target);
        writeJson(res, 200, { stopped: ok, sessionKey: target });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (req.method === 'POST' && pathname === '/alias') {
      if (!requireAuth(req, config, res)) return;

      try {
        const body = (await readJsonBody(req)) as {
          action?: string;
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
          const targetSessionKey = control.resolveSessionReference(body.sessionKey) || body.sessionKey.trim();
          try {
            await control.setAlias(body.alias, targetSessionKey);
          } catch (error) {
            if (error instanceof Error && error.message === 'invalid_alias') {
              writeJson(res, 400, { error: 'alias must be 1-64 chars: letters, numbers, . _ -' });
              return;
            }
            throw error;
          }
          writeJson(res, 200, { alias: body.alias, sessionKey: targetSessionKey });
          return;
        }

        if (body.action === 'unset' || body.action === 'remove') {
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

    if (pathname === '/tasks' && req.method === 'GET') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.tasks) {
        writeJson(res, 501, { error: 'task_orchestrator_not_configured' });
        return;
      }

      const state = url.searchParams.get('state');
      const tasks = services.tasks.listTasks();
      const filtered = state ? tasks.filter((task) => task.state === state) : tasks;
      const reports = services.tasks.listTaskReports(filtered.map((task) => task.id));
      writeJson(res, 200, {
        tasks: filtered.map((task, index) => ({
          ...task,
          report: reports[index],
        })),
      });
      return;
    }

    if (pathname === '/tasks' && req.method === 'POST') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.tasks) {
        writeJson(res, 501, { error: 'task_orchestrator_not_configured' });
        return;
      }

      try {
        const body = (await readJsonBody(req)) as {
          text?: string;
          repoId?: string;
          sessionKey?: string;
          source?: 'transport' | 'webhook' | 'operator' | 'system';
          fanout?: string[];
        };

        if (!body.text || !body.text.trim()) {
          writeJson(res, 400, { error: 'text required' });
          return;
        }

        const task = await services.tasks.submitTask({
          text: body.text,
          repoId: body.repoId,
          sessionKey: body.sessionKey,
          source: body.source,
          fanout: body.fanout,
        });

        writeJson(res, 200, { task });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (pathname === '/workers' && req.method === 'GET') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.tasks) {
        writeJson(res, 501, { error: 'task_orchestrator_not_configured' });
        return;
      }

      const workers = await services.tasks.getWorkerRuntimeSnapshot();
      writeJson(res, 200, workers);
      return;
    }

    if (pathname === '/workers/cleanup' && req.method === 'POST') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.tasks) {
        writeJson(res, 501, { error: 'task_orchestrator_not_configured' });
        return;
      }

      const cleanup = await services.tasks.cleanupOrphanedWorkers();
      writeJson(res, 200, cleanup);
      return;
    }

    const workerRoute = tryExtractWorkerRoute(pathname);
    if (workerRoute) {
      if (!requireAuth(req, config, res)) return;
      if (!services?.tasks) {
        writeJson(res, 501, { error: 'task_orchestrator_not_configured' });
        return;
      }

      if (workerRoute.action === 'stop' && req.method === 'POST') {
        try {
          const stopped = await services.tasks.stopWorkerSession(workerRoute.session);
          writeJson(res, 200, stopped);
        } catch (error) {
          writeJson(res, 400, { error: (error as Error).message });
        }
        return;
      }

      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    const taskRoute = tryExtractTaskRoute(pathname);
    if (taskRoute) {
      if (!requireAuth(req, config, res)) return;
      if (!services?.tasks) {
        writeJson(res, 501, { error: 'task_orchestrator_not_configured' });
        return;
      }

      if (taskRoute.action === 'get' && req.method === 'GET') {
        const task = services.tasks.getTask(taskRoute.id);
        if (!task) {
          writeJson(res, 404, { error: 'task_not_found' });
          return;
        }
        const report = services.tasks.buildTaskReport(taskRoute.id);
        writeJson(res, 200, { task, report });
        return;
      }

      if (taskRoute.action === 'report' && req.method === 'GET') {
        const task = services.tasks.getTask(taskRoute.id);
        if (!task) {
          writeJson(res, 404, { error: 'task_not_found' });
          return;
        }
        const report = services.tasks.buildTaskReport(taskRoute.id);
        writeJson(res, 200, { report });
        return;
      }

      if (taskRoute.action === 'retry' && req.method === 'POST') {
        try {
          const task = await services.tasks.retryTask(taskRoute.id);
          writeJson(res, 200, { task });
        } catch (error) {
          writeJson(res, 400, { error: (error as Error).message });
        }
        return;
      }

      if (taskRoute.action === 'cancel' && req.method === 'POST') {
        const cancelled = await services.tasks.cancelTask(taskRoute.id);
        writeJson(res, 200, { cancelled });
        return;
      }

      writeJson(res, 405, { error: 'method_not_allowed' });
      return;
    }

    if (pathname === '/repos' && req.method === 'GET') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.tasks) {
        writeJson(res, 501, { error: 'task_orchestrator_not_configured' });
        return;
      }
      writeJson(res, 200, { repos: services.tasks.listRepos() });
      return;
    }

    if (pathname === '/repos/register' && req.method === 'POST') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.tasks) {
        writeJson(res, 501, { error: 'task_orchestrator_not_configured' });
        return;
      }

      try {
        const body = (await readJsonBody(req)) as {
          id?: string;
          path?: string;
          defaultBranch?: string;
          remote?: string;
          isDefault?: boolean;
        };

        if (!body.id || !body.path) {
          writeJson(res, 400, { error: 'id and path required' });
          return;
        }

        const repo = await services.tasks.registerRepo({
          id: body.id,
          path: body.path,
          defaultBranch: body.defaultBranch,
          remote: body.remote,
          isDefault: Boolean(body.isDefault),
        });

        writeJson(res, 200, { repo });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (pathname === '/repos/remove' && req.method === 'POST') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.tasks) {
        writeJson(res, 501, { error: 'task_orchestrator_not_configured' });
        return;
      }

      const body = (await readJsonBody(req)) as { id?: string };
      if (!body.id) {
        writeJson(res, 400, { error: 'id required' });
        return;
      }
      const removed = await services.tasks.removeRepo(body.id);
      writeJson(res, 200, { removed });
      return;
    }

    if (pathname === '/bridge/envelope' && req.method === 'POST') {
      if (!services?.bridge) {
        writeJson(res, 501, { error: 'bridge_not_configured' });
        return;
      }

      if (!config.BRIDGE_SHARED_SECRET && !requireAuth(req, config, res)) return;

      try {
        const body = await readJsonBody(req);
        const repoIdRaw = (body as { repoId?: unknown }).repoId;
        const repoId = typeof repoIdRaw === 'string' && repoIdRaw.trim() ? repoIdRaw : undefined;
        const accepted = await services.bridge.accept(body, bridgeSignature(req), { repoId });

        writeJson(res, accepted.ack ? 200 : 401, {
          ...accepted,
        });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (pathname === '/webhook/github' && req.method === 'POST') {
      if (!services?.bridge) {
        writeJson(res, 501, { error: 'bridge_not_configured' });
        return;
      }

      if (!config.BRIDGE_SHARED_SECRET && !requireAuth(req, config, res)) return;

      try {
        const payload = await readJsonBody(req);
        const deliveryId = String(req.headers['x-github-delivery'] || randomId());
        const event = String(req.headers['x-github-event'] || 'unknown');

        const envelope = {
          messageId: deliveryId,
          source: 'github',
          type: event,
          payload,
          timestamp: Date.now(),
        };

        const accepted = services.bridge.accept(envelope, bridgeSignature(req));
        const queued = await accepted;

        writeJson(res, queued.ack ? 200 : 401, {
          ...queued,
        });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (pathname === '/bridge/status' && req.method === 'GET') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.bridge) {
        writeJson(res, 501, { error: 'bridge_not_configured' });
        return;
      }
      writeJson(res, 200, {
        health: services.bridge.getHealth(),
        recent: services.bridge.listRecords(100),
      });
      return;
    }

    if (pathname === '/sentry/status' && req.method === 'GET') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.sentry) {
        writeJson(res, 501, { error: 'sentry_not_configured' });
        return;
      }

      writeJson(res, 200, {
        status: services.sentry.getStatus(),
        incidents: services.sentry.listIncidents(100),
      });
      return;
    }

    if (pathname === '/release/status' && req.method === 'GET') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.release) {
        writeJson(res, 501, { error: 'release_manager_not_configured' });
        return;
      }

      writeJson(res, 200, {
        release: await services.release.status(),
      });
      return;
    }

    if (pathname === '/release/update' && req.method === 'POST') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.release) {
        writeJson(res, 501, { error: 'release_manager_not_configured' });
        return;
      }

      try {
        const body = (await readJsonBody(req)) as { sourceDir?: string };
        const sourceDir = body.sourceDir?.trim() || process.cwd();

        const snapshot = await services.release.createSnapshot(sourceDir);
        await services.release.activate(snapshot.sha);

        writeJson(res, 200, {
          activated: snapshot.sha,
          snapshot,
          status: await services.release.status(),
        });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (pathname === '/release/rollback' && req.method === 'POST') {
      if (!requireAuth(req, config, res)) return;
      if (!services?.release) {
        writeJson(res, 501, { error: 'release_manager_not_configured' });
        return;
      }

      try {
        const body = (await readJsonBody(req)) as { target?: string };
        const target = body.target?.trim() || 'previous';
        const activePath = await services.release.rollback(target);
        writeJson(res, 200, {
          rolledBackTo: activePath,
          status: await services.release.status(),
        });
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    if (pathname === '/audit' && req.method === 'POST') {
      if (!requireAuth(req, config, res)) return;
      const audit = await runSecurityAudit(config, services?.release);
      writeJson(res, audit.ok ? 200 : 500, audit);
      return;
    }

    if (pathname === '/diagnostics/bundle' && req.method === 'POST') {
      if (!requireAuth(req, config, res)) return;

      try {
        const body = (await readJsonBody(req)) as { outputDir?: string };
        const fallbackOutput = services?.diagnosticsOutputDir || path.join(config.DATA_DIR.replace('~', process.env.HOME || ''), 'diagnostics');
        const outputDir = body.outputDir?.trim() || fallbackOutput;
        await ensureDir(outputDir);

        const audit = await runSecurityAudit(config, services?.release);
        const bundle = await createDiagnosticsBundle({
          outputDir,
          config,
          control,
          tasks: services?.tasks,
          release: services?.release,
          audit,
        });

        writeJson(res, 200, bundle);
      } catch (error) {
        writeJson(res, 400, { error: (error as Error).message });
      }
      return;
    }

    writeJson(res, 404, { error: 'Not Found' });
  });

  return new Promise<http.Server>((resolve) => {
    server.listen(port, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      logger.info(`HTTP control listening on ${boundPort}`);
      resolve(server);
    });
  });
};
