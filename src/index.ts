import path from 'node:path';
import { config } from './config.js';
import { createLogger } from './utils/logger.js';
import { ControlPlane } from './control/index.js';
import { createHttpServer } from './runtime/http.js';
import { SlackTransport } from './transports/slack/index.js';
import { DiscordTransport } from './transports/discord/index.js';
import { createSocketServer } from './runtime/socket.js';
import { validateStartupConfig } from './utils/startup.js';
import { TaskOrchestrator } from './orchestration/task-orchestrator.js';
import { InboundBridge } from './bridge/inbound-bridge.js';
import { ReleaseManager } from './ops/release-manager.js';

const logger = createLogger('talonbot', config.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error');

const run = async () => {
  const startupIssues = validateStartupConfig(config);
  const hasStartupError = startupIssues.some((issue) => issue.severity === 'error');

  for (const issue of startupIssues) {
    if (issue.severity === 'error') {
      logger.error(`[startup/${issue.area}] ${issue.message}`);
    } else {
      logger.warn(`[startup/${issue.area}] ${issue.message}`);
    }
  }

  if (hasStartupError) {
    logger.error('startup checks failed, aborting');
    process.exit(1);
  }

  const control = new ControlPlane(config);
  await control.initialize();

  const taskOrchestrator = new TaskOrchestrator(config);
  await taskOrchestrator.initialize();

  const bridge = new InboundBridge(config.BRIDGE_SHARED_SECRET);
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
        diagnosticsOutputDir: path.join(config.DATA_DIR.replace('~', process.env.HOME || ''), 'diagnostics'),
      },
    );
    runtimeHandles.push({
      close: async () => {
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

  const socketServer = createSocketServer(control, config, createLogger('runtime.socket', config.LOG_LEVEL as any));
  runtimeHandles.push(socketServer);

  logger.info(`talonbot started with ${transports.length} transport(s), sessions dir=${config.DATA_DIR}`);

  const shutdown = async () => {
    logger.info('shutdown signal received');
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
  logger.error('fatal', err as any);
  process.exit(1);
});
