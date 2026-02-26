import type { AppConfig } from '../config';

export const hasMatch = (value: string, exact: string[]) => {
  if (!exact.length) return true;
  return exact.includes(value);
};

export const hasPrefix = (value: string, prefixes: string[]) => {
  if (!prefixes.length) return true;
  return prefixes.some((prefix) => value.startsWith(prefix));
};

export const isAllowedSlack = (config: AppConfig, channelId: string, userId: string) => {
  const allowedChannel = hasMatch(channelId, config.SLACK_ALLOWED_CHANNELS) || hasPrefix(channelId, config.SLACK_ALLOWED_CHANNEL_PREFIXES);
  const allowedUser = hasMatch(userId, config.SLACK_ALLOWED_USERS);

  if (config.SLACK_ALLOWED_CHANNELS.length || config.SLACK_ALLOWED_CHANNEL_PREFIXES.length) {
    if (!allowedChannel) return false;
  }

  if (config.SLACK_ALLOWED_USERS.length) {
    return allowedUser;
  }

  return true;
};

export const isAllowedDiscord = (config: AppConfig, channelId: string, guildId: string | null, userId: string) => {
  if (config.DISCORD_ALLOWED_CHANNELS.length && !hasMatch(channelId, config.DISCORD_ALLOWED_CHANNELS)) {
    return false;
  }

  if (guildId && config.DISCORD_ALLOWED_GUILDS.length && !hasMatch(guildId, config.DISCORD_ALLOWED_GUILDS)) {
    return false;
  }

  if (config.DISCORD_ALLOWED_USERS.length && !hasMatch(userId, config.DISCORD_ALLOWED_USERS)) {
    return false;
  }

  return true;
};
