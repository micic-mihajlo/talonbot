import type { IncomingHttpHeaders } from 'node:http';
import { Chat, type Adapter } from 'chat';
import { createSlackAdapter, type SlackAdapter } from '@chat-adapter/slack';
import { createDiscordAdapter, type DiscordAdapter } from '@chat-adapter/discord';
import { createRedisState } from '@chat-adapter/state-redis';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { AppConfig } from '../../config.js';
import type { ControlPlane } from '../../control/index.js';
import { createLogger } from '../../utils/logger.js';
import type { ChatTransport, ChatTransportHealth } from '../chat-interface.js';
import { TransportOutbox } from '../outbox.js';
import { EventDedupeGuard, inboundDedupeKey } from '../event-dedupe.js';
import { fromWebhookResponse, toWebhookRequest } from './webhooks.js';
import { parseThreadIdentity, toAdapterThreadId, toInboundMessage, type ChatSdkSource, type ThreadIdentity } from './mapper.js';

const logger = createLogger('transports.chat-sdk', 'info');

type OutboundPayload = { channelId: string; threadId?: string; text: string };

export class ChatSdkTransport implements ChatTransport {
  private chat?: Chat<Record<string, Adapter>>;
  private slackAdapter?: SlackAdapter;
  private discordAdapter?: DiscordAdapter;
  private slackOutbox?: TransportOutbox<OutboundPayload>;
  private discordOutbox?: TransportOutbox<OutboundPayload>;
  private started = false;
  private webhookErrors = 0;
  private gatewayClient?: Client;
  private dedupe: EventDedupeGuard;

  constructor(
    private readonly config: AppConfig,
    private readonly control: ControlPlane,
    private readonly options: {
      registerOutboundSenders: boolean;
      shadowTrafficEnabled: boolean;
      dedupeGuard?: EventDedupeGuard;
    },
  ) {
    this.dedupe = options.dedupeGuard || new EventDedupeGuard(this.config.CHAT_SDK_EVENT_DEDUPE_WINDOW_MS);
  }

  name() {
    return 'chat-sdk';
  }

  health(): ChatTransportHealth {
    return {
      healthy: this.started,
      started: this.started,
      details: {
        provider: this.config.CHAT_TRANSPORT_PROVIDER,
        adapters: {
          slack: Boolean(this.slackAdapter),
          discord: Boolean(this.discordAdapter),
        },
        webhookErrors: this.webhookErrors,
        dedupe: this.dedupe.stats(),
      },
    };
  }

  private shouldAcceptInbound(message: ReturnType<typeof toInboundMessage>): boolean {
    const key = inboundDedupeKey(message);
    return this.dedupe.shouldAccept(key);
  }

  private async dispatchInbound(message: ReturnType<typeof toInboundMessage>, thread: ThreadIdentity) {
    if (!this.options.shadowTrafficEnabled && this.config.CHAT_TRANSPORT_PROVIDER === 'dual') {
      return;
    }
    if (!this.shouldAcceptInbound(message)) {
      return;
    }
    await this.control.dispatch(
      message,
      {
        reply: async (text) => {
          await this.enqueueOutbound(message.source, {
            channelId: message.sourceChannelId,
            threadId: thread.threadId,
            text,
          });
        },
      },
    );
  }

  private async sendSlack(payload: OutboundPayload) {
    if (!this.slackAdapter) throw new Error('chat_sdk_slack_not_ready');
    const identity: ThreadIdentity = {
      source: 'slack',
      channelId: payload.channelId,
      threadId: payload.threadId,
    };
    await this.slackAdapter.postMessage(toAdapterThreadId(identity), payload.text);
  }

  private async sendDiscord(payload: OutboundPayload) {
    if (!this.discordAdapter) throw new Error('chat_sdk_discord_not_ready');
    const identity: ThreadIdentity = {
      source: 'discord',
      channelId: payload.channelId,
      threadId: payload.threadId,
      guildId: '@me',
    };
    await this.discordAdapter.postMessage(toAdapterThreadId(identity), payload.text);
  }

  private async enqueueOutbound(source: ChatSdkSource, payload: OutboundPayload, explicitKey?: string) {
    if (source === 'slack') {
      if (!this.slackOutbox) throw new Error('chat_sdk_slack_outbox_not_ready');
      await this.slackOutbox.enqueue({
        idempotencyKey:
          explicitKey?.trim() ||
          `chat-sdk:slack:${payload.channelId}:${payload.threadId || 'main'}:${Date.now()}:${payload.text}`,
        payload,
      });
      return;
    }
    if (!this.discordOutbox) throw new Error('chat_sdk_discord_outbox_not_ready');
    await this.discordOutbox.enqueue({
      idempotencyKey:
        explicitKey?.trim() ||
        `chat-sdk:discord:${payload.channelId}:${payload.threadId || 'main'}:${Date.now()}:${payload.text}`,
      payload,
    });
  }

  private async startGatewayBridge() {
    if (!this.discordAdapter || !this.config.DISCORD_ENABLED || !this.config.DISCORD_TOKEN) {
      return;
    }
    this.gatewayClient = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    const forward = async (event: { type: string; data: unknown }) => {
      const request = new Request('http://127.0.0.1/chat-sdk/webhooks/discord', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-discord-gateway-token': this.config.DISCORD_TOKEN,
        },
        body: JSON.stringify({
          ...event,
          timestamp: Date.now(),
        }),
      });
      const webhook = (this.chat?.webhooks as Record<string, (r: Request) => Promise<Response>> | undefined)?.discord;
      if (!webhook) return;
      await webhook(request);
    };

    this.gatewayClient.on('messageCreate', async (message) => {
      if (message.author?.bot) return;
      await forward({
        type: 'GATEWAY_MESSAGE_CREATE',
        data: message.toJSON(),
      }).catch((error) => logger.warn(`chat-sdk discord gateway forward failed: ${(error as Error).message}`));
    });

    this.gatewayClient.on('messageReactionAdd', async (reaction, user) => {
      await forward({
        type: 'GATEWAY_MESSAGE_REACTION_ADD',
        data: {
          ...(reaction.toJSON() as Record<string, unknown>),
          user: user.toJSON(),
        },
      }).catch((error) => logger.warn(`chat-sdk discord reaction forward failed: ${(error as Error).message}`));
    });

    this.gatewayClient.on('messageReactionRemove', async (reaction, user) => {
      await forward({
        type: 'GATEWAY_MESSAGE_REACTION_REMOVE',
        data: {
          ...(reaction.toJSON() as Record<string, unknown>),
          user: user.toJSON(),
        },
      }).catch((error) => logger.warn(`chat-sdk discord reaction remove forward failed: ${(error as Error).message}`));
    });

    await this.gatewayClient.login(this.config.DISCORD_TOKEN);
  }

  async start() {
    const adapters: Record<string, Adapter> = {};
    if (this.config.SLACK_ENABLED) {
      this.slackAdapter = createSlackAdapter({
        botToken: this.config.SLACK_BOT_TOKEN,
        signingSecret: this.config.SLACK_SIGNING_SECRET,
      });
      adapters.slack = this.slackAdapter;
    }
    if (this.config.DISCORD_ENABLED) {
      this.discordAdapter = createDiscordAdapter({
        botToken: this.config.DISCORD_TOKEN,
        publicKey: this.config.DISCORD_PUBLIC_KEY,
        applicationId: this.config.DISCORD_APPLICATION_ID,
      });
      adapters.discord = this.discordAdapter;
    }
    if (Object.keys(adapters).length === 0) {
      logger.info('chat-sdk transport has no enabled adapters');
      return;
    }

    const redisState = createRedisState({
      url: this.config.CHAT_SDK_REDIS_URL,
      keyPrefix: 'talonbot-chat-sdk',
    });

    this.chat = new Chat({
      userName: 'talonbot',
      adapters,
      state: redisState,
      dedupeTtlMs: this.config.CHAT_SDK_EVENT_DEDUPE_WINDOW_MS,
    });

    this.chat.onNewMention(async (thread, message) => {
      const source = thread.id.startsWith('slack:') ? 'slack' : 'discord';
      const inbound = toInboundMessage(source, {
        threadId: thread.id,
        messageId: message.id,
        text: message.text || '',
        isMention: Boolean(message.isMention),
        senderId: message.author?.userId || 'unknown',
        senderName: message.author?.userName,
        senderIsBot: message.author?.isBot === true,
        attachments: (message.attachments || []) as Array<{ id?: string; name?: string; mimeType?: string; url?: string }>,
        raw: message.raw,
      });
      await this.dispatchInbound(inbound, parseThreadIdentity(source, thread.id));
    });

    this.chat.onSubscribedMessage(async (thread, message) => {
      const source = thread.id.startsWith('slack:') ? 'slack' : 'discord';
      const inbound = toInboundMessage(source, {
        threadId: thread.id,
        messageId: message.id,
        text: message.text || '',
        isMention: Boolean(message.isMention),
        senderId: message.author?.userId || 'unknown',
        senderName: message.author?.userName,
        senderIsBot: message.author?.isBot === true,
        attachments: (message.attachments || []) as Array<{ id?: string; name?: string; mimeType?: string; url?: string }>,
        raw: message.raw,
      });
      await this.dispatchInbound(inbound, parseThreadIdentity(source, thread.id));
    });

    this.slackOutbox = new TransportOutbox(
      `${this.config.TRANSPORT_OUTBOX_STATE_FILE}.chat-sdk.slack`,
      async (payload) => {
        await this.sendSlack(payload);
      },
      this.config.TRANSPORT_OUTBOX_RETRY_BASE_MS,
      this.config.TRANSPORT_OUTBOX_RETRY_MAX_MS,
      this.config.TRANSPORT_OUTBOX_MAX_RETRIES,
      logger,
    );
    await this.slackOutbox.initialize();

    this.discordOutbox = new TransportOutbox(
      `${this.config.TRANSPORT_OUTBOX_STATE_FILE}.chat-sdk.discord`,
      async (payload) => {
        await this.sendDiscord(payload);
      },
      this.config.TRANSPORT_OUTBOX_RETRY_BASE_MS,
      this.config.TRANSPORT_OUTBOX_RETRY_MAX_MS,
      this.config.TRANSPORT_OUTBOX_MAX_RETRIES,
      logger,
    );
    await this.discordOutbox.initialize();

    if (this.options.registerOutboundSenders) {
      if (this.config.SLACK_ENABLED) {
        this.control.registerOutboundSender('slack', async (message) => {
          await this.enqueueOutbound('slack', {
            channelId: message.channelId,
            threadId: message.threadId,
            text: message.text,
          }, message.idempotencyKey);
        });
      }
      if (this.config.DISCORD_ENABLED) {
        this.control.registerOutboundSender('discord', async (message) => {
          await this.enqueueOutbound('discord', {
            channelId: message.channelId,
            threadId: message.threadId,
            text: message.text,
          }, message.idempotencyKey);
        });
      }
    }

    await this.chat.initialize();
    await this.startGatewayBridge();
    this.started = true;
  }

  async stop() {
    if (this.options.registerOutboundSenders) {
      this.control.unregisterOutboundSender('slack');
      this.control.unregisterOutboundSender('discord');
    }
    await this.gatewayClient?.destroy();
    await this.slackOutbox?.stop().catch(() => undefined);
    await this.discordOutbox?.stop().catch(() => undefined);
    await this.chat?.shutdown();
    this.started = false;
  }

  async handleWebhook(adapter: 'slack' | 'discord', method: string, headers: IncomingHttpHeaders, body: Buffer) {
    const webhook = (this.chat?.webhooks as Record<string, (request: Request) => Promise<Response>> | undefined)?.[adapter];
    if (!webhook) {
      return {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'chat_sdk_adapter_not_enabled' }),
      };
    }
    const request = toWebhookRequest(`http://127.0.0.1/chat-sdk/webhooks/${adapter}`, method, headers, body);
    try {
      const response = await webhook(request);
      return await fromWebhookResponse(response);
    } catch (error) {
      this.webhookErrors += 1;
      return {
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: (error as Error).message }),
      };
    }
  }
}
