import { Client as DiscordClient, WebhookClient } from 'discord.js';
import {
  Client as SerchatClient,
  BotCommand,
  Interaction as SerchatInteraction,
  unwrap,
} from 'serchat.ts';
import { db, EXPIRY_MS, refreshWebhookCache, purgeMessageMap, isRateLimited } from './db';
import { ensureDiscordWebhook } from './discord-handlers';

let discordClientGlobal: DiscordClient;
let serchatClientGlobal: SerchatClient;
const activeSetups = new Set<string>();

export async function ensureSerchatWebhook(
  serchat: SerchatClient,
  serverId: string,
  channelId: string,
): Promise<string> {
  const existing = await db.get(
    'SELECT serchat_webhook_id FROM bridges WHERE serchat_channel_id = ? LIMIT 1',
    [channelId],
  );
  if (existing) {
    return String(existing.serchat_webhook_id);
  }

  const hook = await serchat.webhooks.createWebhook(serverId, channelId, {
    name: 'Discord Bridge',
  });
  return hook.token;
}

export class CappedMap<K, V> {
  private map = new Map<K, V>();
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.max) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    this.map.set(key, value);
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
}

const profilePictureCache = new CappedMap<string, { url: string | null; expiresAt: number }>(500);
const DEBUG_AVATAR_CACHE = process.env.DEBUG_AVATAR_CACHE === 'true';

const serchatUserCache = new CappedMap<string, { displayName: string | null; username: string; expiresAt: number }>(500);

export async function getSerchatUser(
  serchat: SerchatClient,
  userId: string,
): Promise<{ displayName: string | null; username: string } | null> {
  const cached = serchatUserCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return { displayName: cached.displayName, username: cached.username };
  }
  try {
    const profile = await serchat
      .getRest()
      .get<{ displayName?: string | null; username?: string }>(`/profile/${userId}`);
    const data = unwrap(profile);
    if (data && data.username) {
      const resolved = {
        displayName: data.displayName ?? null,
        username: data.username,
      };
      serchatUserCache.set(userId, {
        ...resolved,
        expiresAt: Date.now() + 1000 * 60 * 15,
      });
      return resolved;
    }
  } catch (e) {
    console.error(`Failed to fetch profile for Serchat user ${userId}:`, e);
  }
  return null;
}

export async function resolveSerchatMentions(serchat: SerchatClient, content: string): Promise<string> {
  if (!content) return '';
  const regex = /<userid:['"]([a-f\d]{24})['"]>/gi;
  const matches = Array.from(content.matchAll(regex));
  if (matches.length === 0) return content;

  const uniqueIds = Array.from(new Set(matches.map((m) => m[1])));

  const resolvedUsersMap = new Map<string, { displayName: string | null; username: string }>();
  await Promise.all(
    uniqueIds.map(async (id) => {
      const user = await getSerchatUser(serchat, id);
      if (user) {
        resolvedUsersMap.set(id.toLowerCase(), user);
      }
    }),
  );

  return content.replace(regex, (match, id) => {
    const user = resolvedUsersMap.get(id.toLowerCase());
    if (user) {
      return `@${user.displayName || user.username}`;
    }
    return match;
  });
}

const serchatEmojiCache = new CappedMap<string, { name: string; expiresAt: number }>(500);

export async function getSerchatEmoji(
  serchat: SerchatClient,
  emojiId: string,
): Promise<{ name: string } | null> {
  const cached = serchatEmojiCache.get(emojiId);
  if (cached && cached.expiresAt > Date.now()) {
    return { name: cached.name };
  }
  try {
    const response = await serchat
      .getRest()
      .get<{ name: string }>(`/emojis/${emojiId}`);
    const data = unwrap(response);
    if (data && data.name) {
      const resolved = { name: data.name };
      serchatEmojiCache.set(emojiId, {
        ...resolved,
        expiresAt: Date.now() + 1000 * 60 * 60 * 24,
      });
      return resolved;
    }
  } catch (e) {
    console.error(`Failed to fetch custom emoji name for ${emojiId}:`, e);
  }
  return null;
}

export async function resolveSerchatEmojis(serchat: SerchatClient, content: string): Promise<string> {
  if (!content) return '';
  const regex = /<emoji:([a-f\d]{24})>/gi;
  const matches = Array.from(content.matchAll(regex));
  if (matches.length === 0) return content;

  const uniqueIds = Array.from(new Set(matches.map((m) => m[1])));

  const resolvedEmojisMap = new Map<string, { name: string }>();
  await Promise.all(
    uniqueIds.map(async (id) => {
      const emoji = await getSerchatEmoji(serchat, id);
      if (emoji) {
        resolvedEmojisMap.set(id.toLowerCase(), emoji);
      }
    }),
  );

  return content.replace(regex, (match, id) => {
    const emoji = resolvedEmojisMap.get(id.toLowerCase());
    if (emoji) {
      return `:${emoji.name}:`;
    }
    return match;
  });
}


export async function getProfilePicture(
  serchat: SerchatClient,
  userId: string,
): Promise<string | undefined> {
  const cached = profilePictureCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    if (DEBUG_AVATAR_CACHE) {
      console.log(`[avatar] cache hit for ${userId}: ${cached.url}`);
    }
    return cached.url ?? undefined;
  }
  try {
    if (DEBUG_AVATAR_CACHE) {
      console.log(`[avatar] fetching profile for ${userId}`);
    }
    const profile = await serchat
      .getRest()
      .get<{ profilePicture?: string | null }>(`/profile/${userId}`);
    const data = unwrap(profile);
    const raw = data?.profilePicture;

    if (DEBUG_AVATAR_CACHE) {
      console.log(`[avatar] raw profilePicture field:`, raw);
    }

    let url: string | null = null;
    if (typeof raw === 'string' && raw.length > 0) {
      if (raw.startsWith('http')) {
        try {
          const apiOriginUrl = new URL(serchat.getApiOrigin());
          const rawUrl = new URL(raw);
          if (rawUrl.host === apiOriginUrl.host) {
            url = raw;
          }
        } catch (e) {
          url = null;
        }
      } else {
        url = `${serchat.getApiOrigin()}${raw}`;
      }
    }

    if (DEBUG_AVATAR_CACHE) {
      console.log(`[avatar] resolved URL: ${url}`);
    }
    profilePictureCache.set(userId, { url, expiresAt: Date.now() + 5 * 60 * 1000 });
    return url ?? undefined;
  } catch (e: unknown) {
    console.error('[avatar] failed to fetch profile picture:', e);
    return undefined;
  }
}

class AllowBridgingCommand extends BotCommand {
  name = 'allow-bridging';
  description = 'Allow bridging with a Discord server';
  options = {
    discordServerId: {
      type: 'string' as const,
      description: 'Discord Server ID to allow',
      required: true,
    },
  };

  async execute(interaction: SerchatInteraction) {
    const serverId = interaction.serverId;
    if (!serverId) {
      await interaction.reply('Must be used in a server.');
      return;
    }

    const isAdmin = interaction.hasPermission('administrator');
    if (!isAdmin) {
      await interaction.reply('You must be a server administrator to use this command.');
      return;
    }

    const discordServerId = interaction.getString('discordServerId') as string;

    await db.run(
      'INSERT OR IGNORE INTO servers_allowlist (discord_server_id, serchat_server_id, added_by) VALUES (?, ?, "serchat")',
      [discordServerId, serverId],
    );

    await interaction.reply(`Added to allowlist. (Discord Server: ${discordServerId})`);
  }
}

class RemoveBridgeCommand extends BotCommand {
  name = 'remove-bridge';
  description = 'Remove an existing bridge';
  options = {
    discordChannelId: {
      type: 'string' as const,
      description: 'Discord Channel ID',
      required: true,
    },
    serchatChannelId: {
      type: 'string' as const,
      description: 'Serchat Channel ID',
      required: true,
    },
  };

  async execute(interaction: SerchatInteraction) {
    const serverId = interaction.serverId;
    if (!serverId) {
      await interaction.reply('Must be used in a server.');
      return;
    }

    const isAdmin = interaction.hasPermission('administrator');
    if (!isAdmin) {
      await interaction.reply('You must be a server administrator to use this command.');
      return;
    }

    const discordChannelId = interaction.getString('discordChannelId') as string;
    const serchatChannelId = interaction.getString('serchatChannelId') as string;

    const bridge = await db.get(
      'SELECT * FROM bridges WHERE discord_channel_id = ? AND serchat_channel_id = ? AND serchat_server_id = ?',
      [discordChannelId, serchatChannelId, serverId],
    );

    if (!bridge) {
      await interaction.reply(`No matching bridge exists.`);
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
      await serchatClientGlobal.webhooks.deleteWebhook(
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

    await interaction.reply(`Bridge between Discord and Serchat has been removed.`);
    try {
      const discordChannel = await discordClientGlobal.channels.fetch(discordChannelId);
      if (discordChannel?.isTextBased() && 'send' in discordChannel) {
        await discordChannel.send(`Bridge between Discord and Serchat has been removed.`);
      }
    } catch (e: unknown) {
      console.error('Failed to send removal message to Discord:', e);
    }
  }
}

class AcceptBridgeCommand extends BotCommand {
  name = 'accept-bridge';
  description = 'Accept a pending bridge request';
  options = {
    requestId: {
      type: 'string' as const,
      description: 'Bridge Request ID',
      required: true,
    },
  };

  async execute(interaction: SerchatInteraction) {
    const serverId = interaction.serverId;
    if (!serverId) {
      await interaction.reply('Must be used in a server.');
      return;
    }

    const isAdmin = interaction.hasPermission('administrator');
    if (!isAdmin) {
      await interaction.reply('You must be a server administrator to use this command.');
      return;
    }

    const requestId = interaction.getString('requestId') as string;

    const cutoff = Date.now() - EXPIRY_MS;
    const request = await db.get(
      'SELECT * FROM bridge_requests WHERE id = ? AND serchat_channel_id = ? AND serchat_server_id = ? AND status = "pending_serchat" AND created_at >= ?',
      [requestId, interaction.channelId, serverId, cutoff],
    );

    if (!request) {
      await interaction.reply(
        'No active pending bridge request found with that ID in this channel.',
      );
      return;
    }

    const setupKey = `${request.discord_channel_id}-${request.serchat_channel_id}`;
    if (activeSetups.has(setupKey)) {
      await interaction.reply('A bridge setup is already in progress for this channel.');
      return;
    }
    activeSetups.add(setupKey);

    try {
      await db.run('BEGIN EXCLUSIVE TRANSACTION');
      try {
        const bridgeExists = await db.get(
          'SELECT id FROM bridges WHERE discord_channel_id = ? OR serchat_channel_id = ?',
          [request.discord_channel_id, request.serchat_channel_id],
        );
        if (bridgeExists) {
          await db.run('DELETE FROM bridge_requests WHERE id = ?', [request.id]);
          await db.run('COMMIT');
          await interaction.reply('Bridge already exists for one of these channels.');
          return;
        }

        const discordHook = await ensureDiscordWebhook(
          discordClientGlobal,
          String(request.discord_channel_id),
        );
        const serchatToken = await ensureSerchatWebhook(
          serchatClientGlobal,
          String(request.serchat_server_id),
          String(request.serchat_channel_id),
        );

        await db.run(
          `INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            request.discord_channel_id,
            request.discord_server_id,
            request.serchat_channel_id,
            request.serchat_server_id,
            discordHook.id,
            discordHook.token,
            serchatToken,
          ],
        );

        await db.run('DELETE FROM bridge_requests WHERE id = ?', [request.id]);
        await db.run('COMMIT');
      } catch (transactionErr) {
        await db.run('ROLLBACK');
        throw transactionErr;
      }

      await refreshWebhookCache();

      await interaction.reply(
        `Bridge active between Discord <#${request.discord_channel_id}> and this channel.`,
      );
      try {
        const discordChannel = await discordClientGlobal.channels.fetch(
          String(request.discord_channel_id),
        );
        if (discordChannel?.isTextBased() && 'send' in discordChannel) {
          await discordChannel.send(`Bridge active between Discord and Serchat.`);
        }
      } catch (e: unknown) {
        console.error('Failed to notify Discord of bridge acceptance:', e);
      }
    } catch (e: unknown) {
      console.error('Failed to finalize bridge:', e);
      await interaction.reply(
        'Failed to finalize bridge creation. Ensure bot permissions are correct.',
      );
    } finally {
      activeSetups.delete(setupKey);
    }
  }
}

export function setupSerchatHandlers(discord: DiscordClient, serchat: SerchatClient) {
  discordClientGlobal = discord;
  serchatClientGlobal = serchat;

  serchat.on('ready', async () => {
    console.log(`[Serchat] Logged in as ${serchat.user?.username}`);

    serchat.commands.register(new AllowBridgingCommand());
    serchat.commands.register(new RemoveBridgeCommand());
    serchat.commands.register(new AcceptBridgeCommand());

    try {
      await serchat.commands.sync();
      console.log('[Serchat] Successfully registered commands.');
    } catch (e: unknown) {
      console.error('[Serchat] Error syncing commands:', e);
    }
  });

  serchat.on('messageCreate', async (msg) => {
    if (msg.senderId === serchat.user?.id) return;
    if (msg.isWebhook) return;

    if (msg.poll) return;
    if (msg.stickerId) return;

    if (!msg.text?.trim() && !msg.hasAttachments()) return;

    const content = msg.text?.trim().toLowerCase();

    if (content === 'accept') {
      const isAdmin = await serchat.hasPermission(msg.serverId, msg.senderId, 'administrator');
      if (!isAdmin) {
        await msg.reply('You must be a server administrator to accept a bridge request.');
        return;
      }

      const cutoff = Date.now() - EXPIRY_MS;
      const request = await db.get(
        'SELECT * FROM bridge_requests WHERE serchat_channel_id = ? AND serchat_server_id = ? AND status = "pending_serchat" AND created_at >= ?',
        [msg.channelId, msg.serverId, cutoff],
      );

      if (request) {
        const setupKey = `${request.discord_channel_id}-${request.serchat_channel_id}`;
        if (activeSetups.has(setupKey)) {
          await msg.reply('A bridge setup is already in progress for this channel.');
          return;
        }
        activeSetups.add(setupKey);

        try {
          await db.run('BEGIN EXCLUSIVE TRANSACTION');
          try {
            const bridgeExists = await db.get(
              'SELECT id FROM bridges WHERE discord_channel_id = ? OR serchat_channel_id = ?',
              [request.discord_channel_id, request.serchat_channel_id],
            );
            if (bridgeExists) {
              await db.run('DELETE FROM bridge_requests WHERE id = ?', [request.id]);
              await db.run('COMMIT');
              await msg.reply('Bridge already exists for one of these channels.');
              return;
            }

            const discordHook = await ensureDiscordWebhook(
              discord,
              String(request.discord_channel_id),
            );
            const serchatToken = await ensureSerchatWebhook(
              serchat,
              String(request.serchat_server_id),
              String(request.serchat_channel_id),
            );

            await db.run(
              `INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                request.discord_channel_id,
                request.discord_server_id,
                request.serchat_channel_id,
                request.serchat_server_id,
                discordHook.id,
                discordHook.token,
                serchatToken,
              ],
            );

            await db.run('DELETE FROM bridge_requests WHERE id = ?', [request.id]);
            await db.run('COMMIT');
          } catch (transactionErr) {
            await db.run('ROLLBACK');
            throw transactionErr;
          }

          await refreshWebhookCache();

          await msg.reply(
            `Bridge active between Discord <#${request.discord_channel_id}> and this channel.`,
          );
          try {
            const discordChannel = await discord.channels.fetch(String(request.discord_channel_id));
            if (discordChannel?.isTextBased() && 'send' in discordChannel) {
              await discordChannel.send(`Bridge active between Discord and Serchat.`);
            }
          } catch (e: unknown) {
            console.error('Failed to notify Discord of bridge acceptance:', e);
          }
        } catch (e: unknown) {
          console.error('Failed to finalize bridge:', e);
          await msg.reply(
            'Failed to finalize bridge creation. Ensure bot permissions are correct.',
          );
        } finally {
          activeSetups.delete(setupKey);
        }
      }
      return;
    }

    const bridges = await db.all('SELECT * FROM bridges WHERE serchat_channel_id = ?', [
      msg.channelId,
    ]);
    if (bridges.length === 0) return;

    if (isRateLimited(`serchat-${msg.channelId}`)) return;

    const username = msg.senderUsername;
    const avatarUrl = await getProfilePicture(serchat, msg.senderId);

    let finalContent = await resolveSerchatMentions(serchat, msg.text || '');
    finalContent = await resolveSerchatEmojis(serchat, finalContent);
    let repliedTo = msg.repliedTo;
    if (!repliedTo && msg.replyToId) {
      try {
        const response = await serchat
          .getRest()
          .get<{
            message: {
              messageId: string;
              _id?: string;
              senderId: string;
              senderUsername?: string;
              isWebhook?: boolean;
              webhookUsername?: string;
              text: string;
            };
          }>(
            `/servers/${msg.serverId}/channels/${msg.channelId}/messages/${msg.replyToId}`
          );
        const data = unwrap(response);
        if (data && data.message) {
          let resolvedUsername = data.message.senderUsername;
          if (data.message.isWebhook && data.message.webhookUsername) {
            resolvedUsername = data.message.webhookUsername;
          } else if (!resolvedUsername && data.message.senderId) {
            const user = await getSerchatUser(serchat, data.message.senderId);
            if (user) {
              resolvedUsername = user.displayName || user.username;
            }
          }
          repliedTo = {
            messageId: data.message.messageId || data.message._id || '',
            senderId: data.message.senderId,
            senderUsername: resolvedUsername || 'User',
            text: data.message.text,
          };
        }
      } catch (err) {
        console.error(`Failed to fetch replied-to message ${msg.replyToId}:`, err);
      }
    }

    if (repliedTo) {
      if (!repliedTo.senderUsername && repliedTo.senderId) {
        const user = await getSerchatUser(serchat, repliedTo.senderId);
        if (user) {
          repliedTo.senderUsername = user.displayName || user.username;
        } else {
          repliedTo.senderUsername = 'User';
        }
      }
      let repliedContent = await resolveSerchatMentions(serchat, repliedTo.text || '');
      repliedContent = await resolveSerchatEmojis(serchat, repliedContent);
      finalContent = `> **${repliedTo.senderUsername}**: ${repliedContent.replace(/\n/g, '\n> ')}\n${finalContent}`;
    }

    if (msg.hasAttachments()) {
      const urls = msg.attachments!
        .map((a) => msg.getAttachmentUrl(a))
        .join('\n');
      finalContent += `\n${urls}`;
    }

    if (finalContent.length > 1990) {
      finalContent = finalContent.substring(0, 1990) + '…';
    }

    for (const bridge of bridges) {
      try {
        const webhookClient = new WebhookClient({
          id: String(bridge.discord_webhook_id),
          token: String(bridge.discord_webhook_token),
        });
        const response = await webhookClient.send({
          content: finalContent || ' ',
          username,
          avatarURL: avatarUrl,
          allowedMentions: { parse: [] },
        });

        await db.run(
          `INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)`,
          ['serchat', msg.messageId, 'discord', bridge.discord_channel_id, response.id],
        );
      } catch (e: unknown) {
        console.error('[Serchat->Discord] Failed to forward message:', e);
        try {
          await serchat.sendMessage(
            bridge.serchat_server_id,
            bridge.serchat_channel_id,
            `**Bridge Error**: Failed to forward message to Discord.`,
          );
        } catch (err) {
          console.error('[Serchat->Discord] Failed to send failure alert to Serchat channel:', err);
        }
      }
    }
  });

  serchat.on('messageUpdate', async (payload) => {
    const mappings = await db.all(
      'SELECT * FROM message_map WHERE source_platform = "serchat" AND source_message_id = ?',
      [payload.messageId],
    );
    if (mappings.length === 0) return;

    let content = await resolveSerchatMentions(serchat, payload.text || ' ');
    content = await resolveSerchatEmojis(serchat, content);
    for (const map of mappings) {
      try {
        const bridge = await db.get(
          'SELECT discord_webhook_id, discord_webhook_token FROM bridges WHERE discord_channel_id = ?',
          [map.target_channel_id],
        );
        if (bridge) {
          const webhookClient = new WebhookClient({
            id: String(bridge.discord_webhook_id),
            token: String(bridge.discord_webhook_token),
          });
          await webhookClient.editMessage(String(map.target_webhook_message_id), { content });
        }
      } catch (e: unknown) {
        console.error('[Serchat->Discord] Failed to edit message:', e);
      }
    }
  });

  serchat.on('messageDelete', async (payload) => {
    const mappings = await db.all(
      'SELECT * FROM message_map WHERE source_platform = "serchat" AND source_message_id = ?',
      [payload.messageId],
    );
    if (mappings.length === 0) return;

    for (const map of mappings) {
      try {
        const bridge = await db.get(
          'SELECT discord_webhook_id, discord_webhook_token FROM bridges WHERE discord_channel_id = ?',
          [map.target_channel_id],
        );
        if (bridge) {
          const webhookClient = new WebhookClient({
            id: String(bridge.discord_webhook_id),
            token: String(bridge.discord_webhook_token),
          });
          await webhookClient.deleteMessage(String(map.target_webhook_message_id));
        }
      } catch (e: unknown) {
        console.error('[Serchat->Discord] Failed to delete message:', e);
      }
    }
  });
}
