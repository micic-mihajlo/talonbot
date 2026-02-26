import { Client, GatewayIntentBits, Partials, TextChannel, DMChannel, ThreadChannel } from 'discord.js';
import type { AppConfig } from '../../config.js';
import type { ControlPlane } from '../../control/index.js';
import { createLogger } from '../../utils/logger.js';
import { InboundMessage } from '../../shared/protocol.js';
import { isAllowedDiscord } from '../guards.js';
import { config as envConfig } from '../../config.js';

const logger = createLogger('transports.discord', envConfig.LOG_LEVEL as any);

const stripBotMention = (content: string, botId: string) => {
  const escaped = new RegExp(`<@!?${botId}>`, 'g');
  return content.replace(escaped, '').trim();
};

export class DiscordTransport {
  private client?: Client;

  constructor(private readonly config: AppConfig, private readonly control: ControlPlane) {}

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

      await this.control.dispatch(inbound, {
        reply: async (text) => {
          if (!this.client) return;
          if (!this.client.user) return;

          if (message.channel instanceof DMChannel) {
            await message.channel.send(text);
            return;
          }

          try {
            const isThread = message.channel.isThread();
            if (isThread) {
              await message.channel.send({ content: text });
            } else {
              await message.reply({ content: text });
            }
          } catch (err) {
            logger.error('discord reply failed', err as unknown);
            if (message.channel instanceof TextChannel) {
              await message.channel.send(text);
            }
          }
        },
      });
    });

    await this.client.login(this.config.DISCORD_TOKEN);
    logger.info('Discord transport connected');
  }

  async stop() {
    if (!this.client) return;
    await this.client.destroy();
    logger.info('Discord transport stopped');
  }
}
