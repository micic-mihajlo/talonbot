import crypto from 'node:crypto';
import { App, LogLevel } from '@slack/bolt';
import type { AppConfig } from '../../config.js';
import type { ControlPlane } from '../../control/index.js';
import { createLogger } from '../../utils/logger.js';
import { InboundMessage } from '../../shared/protocol.js';
import { isAllowedSlack } from '../guards.js';
import { config as envConfig } from '../../config.js';
import { TransportOutbox } from '../outbox.js';

const logger = createLogger('transports.slack', envConfig.LOG_LEVEL as any);

export class SlackTransport {
  private app?: App;
  private botUserId?: string;
  private outbox?: TransportOutbox<{ channelId: string; threadId?: string; text: string }>;

  constructor(private readonly config: AppConfig, private readonly control: ControlPlane) {}

  private outboxKey(prefix: string, input: { channelId: string; threadId?: string; text: string }) {
    const hash = crypto.createHash('sha1').update(input.text).digest('hex');
    return `${prefix}:${input.channelId}:${input.threadId || 'main'}:${hash}`;
  }

  private async sendViaApi(message: { channelId: string; threadId?: string; text: string }) {
    if (!this.app) {
      throw new Error('slack_app_not_ready');
    }

    await this.app.client.chat.postMessage({
      channel: message.channelId,
      text: message.text,
      thread_ts: message.threadId,
      mrkdwn: true,
    });
  }

  private async enqueueOutbound(prefix: string, message: { channelId: string; threadId?: string; text: string }) {
    if (!this.outbox) {
      throw new Error('slack_outbox_not_ready');
    }

    await this.outbox.enqueue({
      idempotencyKey: this.outboxKey(prefix, message),
      payload: message,
    });
  }

  private buildInboundMessage(message: any, threadTs: string | undefined, botUserId: string): InboundMessage {
    const attachments = (message.files || []).map((file: { id?: string; name?: string; mimetype?: string; url_private?: string }) => ({
      id: file.id ?? `${file.name}-${Date.now()}`,
      filename: file.name,
      contentType: file.mimetype,
      url: file.url_private,
    }));

    const text = this.normalizeText(message.text ?? '', botUserId, message.text?.includes(`<@${botUserId}>`) ?? false);

    return {
      id: message.client_msg_id ?? `${message.ts}-${message.user ?? message.bot_id}`,
      source: 'slack',
      sourceChannelId: message.channel,
      sourceThreadId: threadTs ?? undefined,
      sourceMessageId: message.ts,
      senderId: message.user ?? message.bot_id ?? 'unknown',
      senderName: message.username,
      senderIsBot: !!message.bot_id,
      text,
      mentionsBot: text !== (message.text ?? ''),
      attachments,
      metadata: {
        team: message.team,
        threadTs: threadTs || message.ts,
      },
      receivedAt: new Date().toISOString(),
    };
  }

  private normalizeText(text: string, selfId: string, wasMentioned: boolean) {
    let clean = text;
    if (wasMentioned && selfId) {
      clean = clean.replace(new RegExp(`<@${selfId}(?:\\|[^>]+)?>`, 'g'), '').trim();
    }
    return clean;
  }

  async start() {
    if (!this.config.SLACK_ENABLED) {
      logger.info('Slack transport disabled');
      return;
    }

    if (!this.config.SLACK_BOT_TOKEN || !this.config.SLACK_APP_TOKEN || !this.config.SLACK_SIGNING_SECRET) {
      throw new Error('Slack is enabled but SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_SIGNING_SECRET must be set');
    }

    this.app = new App({
      token: this.config.SLACK_BOT_TOKEN,
      appToken: this.config.SLACK_APP_TOKEN,
      signingSecret: this.config.SLACK_SIGNING_SECRET,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    this.outbox = new TransportOutbox(
      `${this.config.TRANSPORT_OUTBOX_STATE_FILE}.slack`,
      async (message) => {
        await this.sendViaApi(message);
      },
      this.config.TRANSPORT_OUTBOX_RETRY_BASE_MS,
      this.config.TRANSPORT_OUTBOX_RETRY_MAX_MS,
      this.config.TRANSPORT_OUTBOX_MAX_RETRIES,
      logger,
    );
    await this.outbox.initialize();
    this.control.registerOutboundSender('slack', async (message) => {
      await this.enqueueOutbound('notify', {
        channelId: message.channelId,
        threadId: message.threadId,
        text: message.text,
      });
    });

    this.app.message(async (args: any) => {
      const message = args.message as any;
      if (!message || message.subtype || !message.text || !('user' in message)) return;
      if ((message as any).user === this.botUserId) return;

      const isDM = message.channel.startsWith('D');
      const isMention = !!this.botUserId && message.text.includes(`<@${this.botUserId}>`);
      if (!isDM && !isMention) return;

      if (!isAllowedSlack(this.config, message.channel, message.user)) {
        logger.warn(`Slack event blocked for channel=${message.channel} user=${message.user}`);
        return;
      }
      const thread = (message as any).thread_ts;
      const inbound = this.buildInboundMessage(message as any, thread, this.botUserId || '');
      const finalText = this.normalizeText(message.text, this.botUserId || '', isMention);

      if (!finalText) return;
      inbound.text = finalText;

      await this.control.dispatch(inbound, {
        reply: async (text) => {
          await this.enqueueOutbound(`dispatch:${message.ts}`, {
            channelId: message.channel,
            threadId: isDM ? undefined : thread || message.ts,
            text,
          });
        },
      });

      logger.debug(`Slack event enqueued source=${message.channel} thread=${thread || 'main'} ts=${message.ts}`);
    });

    await this.app.start();
    const response = await this.app.client.auth.test();
    this.botUserId = response.user_id || '';
    logger.info(`Slack transport started as bot=${this.botUserId}`);
  }

  async stop() {
    this.control.unregisterOutboundSender('slack');
    await this.outbox?.stop().catch(() => undefined);
    this.outbox = undefined;
    if (!this.app) return;
    await this.app.stop();
    logger.info('Slack transport stopped');
  }
}
