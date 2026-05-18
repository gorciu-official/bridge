import { Client as DiscordClient, WebhookClient, type Message } from 'discord.js';
import { Client as SerchatClient } from 'serchat.ts';
import {
  db,
  knownDiscordWebhooks,
  refreshWebhookCache,
  hasMutualAllowlist,
  purgeMessageMap,
  isRateLimited,
} from './db';

const MAX_NO_EMBEDS_URLS = 25;
const DISCORD_FORWARD_REFERENCE_TYPE = 1;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;

type DiscordReadableMessage = Pick<Message, 'content' | 'attachments' | 'mentions'>;

export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,!?;:\]}]+$/g, '');
    if (!urls.includes(url)) {
      urls.push(url);
    }
    if (urls.length >= MAX_NO_EMBEDS_URLS) {
      break;
    }
  }
  return urls;
}

function addNoEmbedUrl(urls: string[], url?: string): void {
  if (!url || urls.length >= MAX_NO_EMBEDS_URLS || urls.includes(url)) {
    return;
  }
  urls.push(url);
}

function collectNoEmbedsUrlsFromDiscordMessage(msg: DiscordReadableMessage): string[] {
  const urls = extractUrls(msg.content || '');
  for (const attachment of msg.attachments.values()) {
    addNoEmbedUrl(urls, attachment.url);
  }
  return urls;
}

function getForwardedDiscordMessage(msg: Message): DiscordReadableMessage | undefined {
  if (msg.reference?.type !== DISCORD_FORWARD_REFERENCE_TYPE) {
    return undefined;
  }
  return msg.messageSnapshots.first();
}

function appendDiscordAttachmentLinks(content: string, msg: DiscordReadableMessage, label = 'Attachment'): string {
  if (msg.attachments.size === 0) {
    return content;
  }

  const urls = Array.from(msg.attachments.values())
    .map((a, i) => `[${label} ${i + 1}](${a.url})`)
    .join('\n');

  return `${content}\n${urls}`;
}

function quoteDiscordMessage(label: string, content: string): string {
  const quotedContent = content.trim() || ' ';
  return `> **${label}**: ${quotedContent.replace(/\n/g, '\n> ')}`;
}

export async function ensureDiscordWebhook(
  discord: DiscordClient,
  channelId: string,
): Promise<{ id: string; token: string }> {
  const existing = await db.get(
    'SELECT discord_webhook_id, discord_webhook_token FROM bridges WHERE discord_channel_id = ? LIMIT 1',
    [channelId],
  );
  if (existing) {
    return {
      id: String(existing.discord_webhook_id),
      token: String(existing.discord_webhook_token),
    };
  }

  const discordChannel = await discord.channels.fetch(channelId);
  if (discordChannel && 'createWebhook' in discordChannel) {
    const hook = await discordChannel.createWebhook({ name: 'Serchat Bridge' });
    return { id: hook.id, token: hook.token! };
  }
  throw new Error(`Cannot create Discord webhook for channel ${channelId}`);
}

export function setupDiscordHandlers(discord: DiscordClient, serchat: SerchatClient) {
  discord.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guildId } = interaction;
    if (!guildId) {
      await interaction.reply({ content: 'Commands must be used in a server.', ephemeral: true });
      return;
    }

    if (!interaction.memberPermissions?.has('Administrator')) {
      await interaction.reply({
        content: 'You must be an Administrator to use this command.',
        ephemeral: true,
      });
      return;
    }

    if (commandName === 'allow-bridging') {
      const serchatServerId = interaction.options.getString('serchatserverid', true).trim().toLowerCase();
      const normalizedGuildId = guildId.trim();
      await db.run(
        'INSERT OR IGNORE INTO servers_allowlist (discord_server_id, serchat_server_id, added_by) VALUES (?, ?, "discord")',
        [normalizedGuildId, serchatServerId],
      );
      await interaction.reply({
        content: `Added to allowlist. (Serchat Server: ${serchatServerId})`,
      });
    }

    if (commandName === 'configure-bridge') {
      const discordChannelId = interaction.options.getString('discordchannelid', true).trim();
      const serchatChannelId = interaction.options.getString('serchatchannelid', true).trim();
      const serchatServerId = interaction.options.getString('serchatserverid', true).trim().toLowerCase();
      const normalizedGuildId = guildId.trim();

      await interaction.deferReply();

      const targetChannel = await discord.channels.fetch(discordChannelId).catch(() => null);
      if (!targetChannel || !('guildId' in targetChannel) || targetChannel.guildId !== guildId) {
        await interaction.editReply('Channel must belong to this server.');
        return;
      }

      const hasMutual = await hasMutualAllowlist(normalizedGuildId, serchatServerId);
      if (!hasMutual) {
        await interaction.editReply({
          content: `Mutual allowlist entry not found. Both Discord and Serchat servers must allow bridging with each other.`,
        });
        return;
      }

      const result = await db.run(
        `INSERT INTO bridge_requests (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, status, initiated_by, created_at)
         VALUES (?, ?, ?, ?, 'pending_serchat', 'discord', ?)`,
        [discordChannelId, normalizedGuildId, serchatChannelId, serchatServerId, Date.now()],
      );

      const requestId = result.lastID;

      try {
        await serchat.sendMessage(
          serchatServerId,
          serchatChannelId,
          `A bridge has been requested from Discord channel <#${discordChannelId}>. A Serchat server admin must type \`/accept-bridge ${requestId}\` or \`accept\` in this channel to confirm.`,
        );
        await interaction.editReply({
          content: `Bridge request sent to Serchat (Request ID: ${requestId}). Waiting for a Serchat admin to accept.`,
        });
      } catch (e: unknown) {
        console.error('[Discord] Error sending message to Serchat:', e);
        await interaction.editReply({ content: `Failed to send request message to Serchat.` });
      }
    }

    if (commandName === 'remove-bridge') {
      const discordChannelId = interaction.options.getString('discordchannelid', true).trim();
      const serchatChannelId = interaction.options.getString('serchatchannelid', true).trim();
      const normalizedGuildId = guildId.trim();

      await interaction.deferReply();

      const bridge = await db.get(
        'SELECT * FROM bridges WHERE discord_channel_id = ? AND serchat_channel_id = ? AND discord_server_id = ?',
        [discordChannelId, serchatChannelId, normalizedGuildId],
      );

      if (!bridge) {
        await interaction.editReply({ content: `No matching bridge exists.` });
        return;
      }

      try {
        const webhookClient = new WebhookClient({
          id: String(bridge.discord_webhook_id),
          token: String(bridge.discord_webhook_token),
        });
        await webhookClient.delete();
      } catch (e: unknown) {
        console.error('Failed to delete Discord webhook:', e);
      }

      try {
        await serchat.webhooks.deleteWebhook(
          String(bridge.serchat_server_id),
          String(bridge.serchat_channel_id),
          String(bridge.serchat_webhook_id),
        );
      } catch (e: unknown) {
        console.error('Failed to delete Serchat webhook:', e);
      }

      await db.run('DELETE FROM bridges WHERE id = ?', [bridge.id]);
      await purgeMessageMap(String(bridge.discord_channel_id), String(bridge.serchat_channel_id));
      await refreshWebhookCache();

      await interaction.editReply({
        content: `Bridge between Discord <#${discordChannelId}> and Serchat has been removed.`,
      });
      try {
        await serchat.sendMessage(
          String(bridge.serchat_server_id),
          String(bridge.serchat_channel_id),
          `Bridge between Discord and this channel has been removed.`,
        );
      } catch (e: unknown) {
        console.error('Failed to send removal message to Serchat:', e);
      }
    }
  });

  discord.on('messageCreate', async (msg) => {
    if (msg.author.bot && !msg.content) return;

    if (msg.webhookId && knownDiscordWebhooks.has(msg.webhookId)) return;

    if (msg.stickers && msg.stickers.size > 0) return;
    if (msg.poll) return;

    if (isRateLimited(`discord-${msg.channel.id}`)) return;

    const bridges = await db.all('SELECT * FROM bridges WHERE discord_channel_id = ?', [
      msg.channel.id,
    ]);
    if (bridges.length === 0) return;

    const content = msg.content || '';
    const username = msg.member?.displayName || msg.author.username;
    const avatarUrl = msg.author.displayAvatarURL();

    let finalContent = resolveDiscordMentions(msg, content);
    let noEmbedsUrls: string[] = [];
    const forwardedMessage = getForwardedDiscordMessage(msg);
    if (forwardedMessage) {
      noEmbedsUrls = collectNoEmbedsUrlsFromDiscordMessage(forwardedMessage);
      const forwardedContent = appendDiscordAttachmentLinks(
        resolveDiscordMentions(forwardedMessage, forwardedMessage.content || ''),
        forwardedMessage,
        'Forwarded attachment',
      );
      const quotedForward = quoteDiscordMessage(`Forwarded by ${username}`, forwardedContent);
      finalContent = finalContent ? `${quotedForward}\n${finalContent}` : quotedForward;
    } else if (msg.reference?.messageId) {
      try {
        const repliedTo = await msg.channel.messages.fetch(msg.reference.messageId);
        noEmbedsUrls = collectNoEmbedsUrlsFromDiscordMessage(repliedTo);
        const repliedContent = resolveDiscordMentions(repliedTo, repliedTo.content || '');
        const quotedReply = quoteDiscordMessage(
          repliedTo.member?.displayName || repliedTo.author.username,
          repliedContent,
        );
        finalContent = finalContent ? `${quotedReply}\n${finalContent}` : quotedReply;
      } catch (e: unknown) {
        console.error('[Discord->Serchat] Failed to fetch replied message context:', e);
      }
    }

    finalContent = appendDiscordAttachmentLinks(finalContent, msg);

    if (finalContent.length > 1990) {
      finalContent = finalContent.substring(0, 1990) + '…';
    }

    for (const bridge of bridges) {
      try {
        const response = await serchat.webhooks.executeWebhook(String(bridge.serchat_webhook_id), {
          content: finalContent || ' ',
          username,
          avatarUrl,
          ...(noEmbedsUrls.length > 0 ? { noEmbedsUrls } : {}),
        });

        await db.run(
          `INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)`,
          ['discord', msg.id, 'serchat', bridge.serchat_channel_id, response.id],
        );
      } catch (e: unknown) {
        console.error('[Discord->Serchat] Failed to forward message:', e);
      }
    }
  });

  discord.on('messageUpdate', async (oldMsg, newMsg) => {
    if (newMsg.author?.bot) return;
    const mappings = await db.all(
      'SELECT * FROM message_map WHERE source_platform = "discord" AND source_message_id = ?',
      [newMsg.id],
    );
    if (mappings.length === 0) return;

    const content = resolveDiscordMentions(newMsg, newMsg.content || ' ');
    for (const map of mappings) {
      try {
        const bridge = await db.get(
          'SELECT serchat_webhook_id FROM bridges WHERE serchat_channel_id = ?',
          [map.target_channel_id],
        );
        if (bridge) {
          await serchat.webhooks.editWebhookMessage(
            String(bridge.serchat_webhook_id),
            String(map.target_webhook_message_id),
            { content },
          );
        }
      } catch (e: unknown) {
        console.error('[Discord->Serchat] Failed to edit message:', e);
      }
    }
  });

  discord.on('messageDelete', async (msg) => {
    const mappings = await db.all(
      'SELECT * FROM message_map WHERE source_platform = "discord" AND source_message_id = ?',
      [msg.id],
    );
    if (mappings.length === 0) return;

    for (const map of mappings) {
      try {
        const bridge = await db.get(
          'SELECT serchat_webhook_id FROM bridges WHERE serchat_channel_id = ?',
          [map.target_channel_id],
        );
        if (bridge) {
          await serchat.webhooks.deleteWebhookMessage(
            String(bridge.serchat_webhook_id),
            String(map.target_webhook_message_id),
          );
        }
      } catch (e: unknown) {
        console.error('[Discord->Serchat] Failed to delete message:', e);
      }
    }

    await db.run('DELETE FROM message_map WHERE source_platform = "discord" AND source_message_id = ?', [
      msg.id,
    ]);
  });

  discord.on('messageDeleteBulk', async (messages) => {
    for (const msg of messages.values()) {
      const mappings = await db.all(
        'SELECT * FROM message_map WHERE source_platform = "discord" AND source_message_id = ?',
        [msg.id],
      );
      if (mappings.length === 0) continue;

      for (const map of mappings) {
        try {
          const bridge = await db.get(
            'SELECT serchat_webhook_id FROM bridges WHERE serchat_channel_id = ?',
            [map.target_channel_id],
          );
          if (bridge) {
            await serchat.webhooks.deleteWebhookMessage(
              String(bridge.serchat_webhook_id),
              String(map.target_webhook_message_id),
            );
          }
        } catch (e: unknown) {
          console.error('[Discord->Serchat] Failed to bulk-delete message:', e);
        }
      }

      await db.run(
        'DELETE FROM message_map WHERE source_platform = "discord" AND source_message_id = ?',
        [msg.id],
      );
    }
  });
}

export interface MentionableMessage {
  mentions?: {
    members?: {
      get(id: string): { displayName?: string; user: { username: string } } | undefined;
    } | null;
    users?: {
      get(id: string): { username: string } | undefined;
    } | null;
  };
}

export function resolveDiscordMentions(msg: MentionableMessage, content: string): string {
  if (!content) return '';
  return content.replace(/<@!?(\d+)>/g, (match, id) => {
    const member = msg.mentions?.members?.get(id);
    if (member) {
      return `@${member.displayName || member.user.username}`;
    }
    const user = msg.mentions?.users?.get(id);
    if (user) {
      return `@${user.username}`;
    }
    return match;
  });
}
