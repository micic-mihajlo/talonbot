import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './utils/logger.js';
import { ControlPlane } from './control/index.js';
import { createHttpServer } from './runtime/http.js';
import { SlackTransport } from './transports/slack/index.js';
import { DiscordTransport } from './transports/discord/index.js';
import { createSocketServer } from './runtime/socket.js';
import {
  formatStartupIssue,
  StartupValidationError,
  type StartupIssue,
  validateStartupConfigOrThrow,
} from './utils/startup.js';
import { TaskOrchestrator } from './orchestration/task-orchestrator.js';
import { BridgeSupervisor } from './bridge/supervisor.js';
import { ReleaseManager } from './ops/release-manager.js';
import { SentryAgent } from './orchestration/sentry-agent.js';

const logger = createLogger('talonbot', config.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error');

const envelopeToTaskText = (source: string, type: string, payload: unknown) => {
  if (payload && typeof payload === 'object') {
    const maybe = payload as { text?: unknown; message?: unknown; action?: unknown; repository?: { full_name?: unknown } };
    const text = typeof maybe.text === 'string' ? maybe.text : typeof maybe.message === 'string' ? maybe.message : '';
    const action = typeof maybe.action === 'string' ? maybe.action : '';
    const repo = typeof maybe.repository?.full_name === 'string' ? maybe.repository.full_name : '';
    return [source, type, action, repo, text].filter(Boolean).join(' ');
  }

  return `${source} ${type}`.trim();
};

const run = async () => {
  let startupIssues: StartupIssue[];
  try {
    startupIssues = validateStartupConfigOrThrow(config);
  } catch (error) {
    if (error instanceof StartupValidationError) {
      startupIssues = error.issues;
    } else {
      throw error;
    }
  }
  const hasStartupError = startupIssues.some((issue) => issue.severity === 'error');

  for (const issue of startupIssues) {
    const rendered = formatStartupIssue(issue);
    if (issue.severity === 'error') {
      logger.error(`[startup/${issue.area}] ${rendered}`);
    } else {
      logger.warn(`[startup/${issue.area}] ${rendered}`);
    }
  }

  if (hasStartupError) {
    throw new StartupValidationError(startupIssues);
  }

  const taskOrchestrator = new TaskOrchestrator(config);
  await taskOrchestrator.initialize();

  const control = new ControlPlane(config, undefined, {
    tasks: taskOrchestrator,
  });
  await control.initialize();
  const socketServer = await createSocketServer(control, config, createLogger('runtime.socket', config.LOG_LEVEL as any));

  const sentry = config.SENTRY_ENABLED
    ? new SentryAgent({
        pollMs: config.SENTRY_POLL_MS,
        stateFile: config.SENTRY_STATE_FILE,
        listTasks: () => taskOrchestrator.listTasks(),
        onEscalation: async (incident) => {
          logger.error(
            `sentry escalation detected task=${incident.taskId} repo=${incident.repoId} state=${incident.state} error=${incident.error || 'none'}`,
          );
        },
      })
    : null;
  if (sentry) {
    await sentry.initialize();
    sentry.start();
  }

  const bridge = new BridgeSupervisor({
    sharedSecret: config.BRIDGE_SHARED_SECRET,
    stateFile: config.BRIDGE_STATE_FILE,
    retryBaseMs: config.BRIDGE_RETRY_BASE_MS,
    retryMaxMs: config.BRIDGE_RETRY_MAX_MS,
    maxRetries: config.BRIDGE_MAX_RETRIES,
    onDispatch: async (envelope, metadata) => {
      if (!config.ENABLE_WEBHOOK_BRIDGE) {
        throw new Error('bridge_disabled');
      }

      const text = envelopeToTaskText(envelope.source, envelope.type, envelope.payload);
      const task = await taskOrchestrator.submitTask({
        text,
        repoId: metadata?.repoId,
      });
      return { taskId: task.id };
    },
  });
  await bridge.initialize();
  const releaseManager = new ReleaseManager(config.RELEASE_ROOT_DIR);
  await releaseManager.initialize();

  const integrity = await releaseManager.integrityCheck(config.STARTUP_INTEGRITY_MODE);
  if (!integrity.ok) {
    const details = `integrity check failed missing=${integrity.missing.length} mismatches=${integrity.mismatches.length}`;
    if (config.STARTUP_INTEGRITY_MODE === 'strict') {
      logger.error(details);
      process.exit(1);
    } else {
      logger.warn(details);
    }
  }

  const transports: { stop: () => Promise<void> }[] = [];
  const runtimeHandles: { close: () => void | Promise<void> }[] = [];
  runtimeHandles.push(socketServer);

  const slack = new SlackTransport(config, control);
  if (config.SLACK_ENABLED) {
    await slack.start();
    transports.push(slack);
  }

  const discord = new DiscordTransport(config, control);
  if (config.DISCORD_ENABLED) {
    await discord.start();
    transports.push(discord);
  }

  if (config.CONTROL_HTTP_PORT > 0) {
    const httpServer = await createHttpServer(
      control,
      config,
      config.CONTROL_HTTP_PORT,
      createLogger('runtime.http', config.LOG_LEVEL as any),
      {
        tasks: taskOrchestrator,
        bridge: config.ENABLE_WEBHOOK_BRIDGE ? bridge : undefined,
        release: releaseManager,
        sentry: sentry || undefined,
        diagnosticsOutputDir: path.join(config.DATA_DIR.replace('~', process.env.HOME || ''), 'diagnostics'),
      },
    );
    runtimeHandles.push({
      close: async () => {
        bridge.stop();
        await new Promise<void>((resolve, reject) => {
          httpServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      },
    });
  }

  logger.info(`talonbot started with ${transports.length} transport(s), sessions dir=${config.DATA_DIR}`);

  const shutdown = async () => {
    logger.info('shutdown signal received');
    sentry?.stop();
    bridge.stop();
    await taskOrchestrator.stop();
    control.stop();
    for (const handle of runtimeHandles) {
      await Promise.resolve(handle.close());
    }
    for (const transport of transports) {
      await transport.stop().catch((err) => logger.error('transport stop failed', err as any));
    }
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};

run().catch((err) => {
  if (err instanceof StartupValidationError) {
    logger.error(`startup checks failed, aborting (${err.errorCount} error(s))`);
    process.exit(1);
    return;
  }
  logger.error('fatal', err as any);
  process.exit(1);
});
