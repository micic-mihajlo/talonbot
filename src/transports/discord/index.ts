import crypto from 'node:crypto';
import { Client, GatewayIntentBits, Partials, DMChannel, ThreadChannel } from 'discord.js';
import type { AppConfig } from '../../config.js';
import type { ControlPlane } from '../../control/index.js';
import { createLogger } from '../../utils/logger.js';
import { InboundMessage } from '../../shared/protocol.js';
import { isAllowedDiscord } from '../guards.js';
import { config as envConfig } from '../../config.js';
import { TransportOutbox } from '../outbox.js';

const logger = createLogger('transports.discord', envConfig.LOG_LEVEL as any);

const stripBotMention = (content: string, botId: string) => {
  const escaped = new RegExp(`<@!?${botId}>`, 'g');
  return content.replace(escaped, '').trim();
};

const startTypingHeartbeat = (channel: { sendTyping?: () => Promise<unknown> }, enabled: boolean) => {
  if (!enabled || typeof channel.sendTyping !== 'function') {
    return () => {};
  }

  const fire = async () => {
    try {
      await channel.sendTyping?.();
    } catch {
      // ignore typing failures
    }
  };

  void fire();
  const timer = setInterval(() => {
    void fire();
  }, 7000);

  return () => clearInterval(timer);
};

export class DiscordTransport {
  private client?: Client;
  private outbox?: TransportOutbox<{ channelId: string; threadId?: string; text: string }>;

  constructor(private readonly config: AppConfig, private readonly control: ControlPlane) {}

  private outboxKey(prefix: string, input: { channelId: string; threadId?: string; text: string }) {
    const hash = crypto.createHash('sha1').update(input.text).digest('hex');
    return `${prefix}:${input.channelId}:${input.threadId || 'main'}:${hash}`;
  }

  private async sendViaApi(message: { channelId: string; threadId?: string; text: string }) {
    if (!this.client) {
      throw new Error('discord_client_not_ready');
    }

    const targetId = message.threadId || message.channelId;
    const channel = await this.client.channels.fetch(targetId);
    if (!channel || !('send' in channel) || typeof (channel as any).send !== 'function') {
      throw new Error(`discord_channel_send_not_available:${targetId}`);
    }
    await (channel as any).send({ content: message.text });
  }

  private async enqueueOutbound(prefix: string, message: { channelId: string; threadId?: string; text: string }) {
    if (!this.outbox) {
      throw new Error('discord_outbox_not_ready');
    }

    await this.outbox.enqueue({
      idempotencyKey: this.outboxKey(prefix, message),
      payload: message,
    });
  }

  async start() {
    if (!this.config.DISCORD_ENABLED) {
      logger.info('Discord transport disabled');
      return;
    }
    if (!this.config.DISCORD_TOKEN) {
      throw new Error('DISCORD_ENABLED=true but DISCORD_TOKEN missing');
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.outbox = new TransportOutbox(
      `${this.config.TRANSPORT_OUTBOX_STATE_FILE}.discord`,
      async (message) => {
        await this.sendViaApi(message);
      },
      this.config.TRANSPORT_OUTBOX_RETRY_BASE_MS,
      this.config.TRANSPORT_OUTBOX_RETRY_MAX_MS,
      this.config.TRANSPORT_OUTBOX_MAX_RETRIES,
      logger,
    );
    await this.outbox.initialize();
    this.control.registerOutboundSender('discord', async (message) => {
      await this.enqueueOutbound('notify', {
        channelId: message.channelId,
        threadId: message.threadId,
        text: message.text,
      });
    });

    this.client.on('messageCreate', async (message) => {
      if (!message.guildId && !(message.channel instanceof DMChannel)) {
        return;
      }

      if (message.author?.bot || !message.content) return;
      if (!message.client.user) return;

      const mentioned = message.mentions.has(message.client.user.id);
      const isDm = message.channel instanceof DMChannel;
      if (!isDm && !mentioned) return;

      const channelId = message.channel.id;
      const guildId = message.guildId ?? null;
      const userId = message.author.id;

      if (!isAllowedDiscord(this.config, channelId, guildId, userId)) {
        logger.warn(`Discord event blocked channel=${channelId} user=${userId}`);
        return;
      }

      const content = stripBotMention(message.content, message.client.user.id);
      const inbound: InboundMessage = {
        id: message.id,
        source: 'discord',
        sourceChannelId: message.channel.id,
        sourceTeamId: undefined,
        sourceGuildId: guildId ?? undefined,
        sourceThreadId: message.channel instanceof ThreadChannel ? message.channel.id : undefined,
        sourceMessageId: message.id,
        senderId: message.author.id,
        senderName: message.author.username,
        senderIsBot: message.author.bot,
        text: content,
        mentionsBot: mentioned,
        attachments: [...message.attachments.values()].map((a) => ({
          id: a.id,
          filename: a.name,
          contentType: a.contentType || undefined,
          url: a.url,
        })),
        metadata: {
          guildId: guildId ?? '',
          channelType: isDm ? 'dm' : 'guild',
        },
        receivedAt: new Date().toISOString(),
      };

      if (!inbound.text) return;

      if (this.config.DISCORD_REACTIONS_ENABLED) {
        try {
          await message.react('👀');
        } catch {
          // ignore reaction failures
        }
      }

      const stopTyping = startTypingHeartbeat(message.channel as { sendTyping?: () => Promise<unknown> }, this.config.DISCORD_TYPING_ENABLED);

      try {
        const result = await this.control.dispatch(inbound, {
          reply: async (text) => {
            const outbound = {
              channelId: message.channel.id,
              threadId: message.channel instanceof ThreadChannel ? message.channel.id : undefined,
              text,
            };
            await this.enqueueOutbound(`dispatch:${message.id}`, outbound);
          },
        });

        if (this.config.DISCORD_REACTIONS_ENABLED) {
          try {
            await message.react(result.accepted ? '✅' : '⚠️');
          } catch {
            // ignore reaction failures
          }
        }
      } catch (err) {
        logger.error('discord dispatch failed', err as unknown);
        if (this.config.DISCORD_REACTIONS_ENABLED) {
          try {
            await message.react('⚠️');
          } catch {
            // ignore reaction failures
          }
        }
      } finally {
        stopTyping();
      }
    });

    await this.client.login(this.config.DISCORD_TOKEN);
    logger.info('Discord transport connected');
  }

  async stop() {
    this.control.unregisterOutboundSender('discord');
    await this.outbox?.stop().catch(() => undefined);
    this.outbox = undefined;
    if (!this.client) return;
    await this.client.destroy();
    logger.info('Discord transport stopped');
  }
}
