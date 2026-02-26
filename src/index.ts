import { config } from './config';
import { createLogger } from './utils/logger';
import { ControlPlane } from './control';
import { createHttpServer } from './runtime/http';
import { SlackTransport } from './transports/slack';
import { DiscordTransport } from './transports/discord';
import { createSocketServer } from './runtime/socket';

const logger = createLogger('talonbot', config.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error');

const run = async () => {
  const control = new ControlPlane(config);
  await control.initialize();

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
    const httpServer = await createHttpServer(control, config, config.CONTROL_HTTP_PORT, createLogger('runtime.http', config.LOG_LEVEL as any));
    runtimeHandles.push({ close: async () => {\n      await new Promise<void>((resolve, reject) => {\n        httpServer.close((error) => {\n          if (error) {\n            reject(error);\n            return;\n          }\n          resolve();\n        });\n      });\n    }});
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
