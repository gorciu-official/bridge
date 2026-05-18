import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('sqlite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sqlite')>();
  return {
    ...actual,
    open: vi.fn().mockImplementation((config) => {
      return actual.open({
        filename: ':memory:',
        driver: config.driver,
      });
    }),
  };
});

const mockWebhookSend = vi.fn().mockResolvedValue({ id: 'dw_msg_id' });
const mockWebhookEditMessage = vi.fn().mockResolvedValue({});
const mockWebhookDeleteMessage = vi.fn().mockResolvedValue({});
const mockWebhookDelete = vi.fn().mockResolvedValue({});

vi.mock('discord.js', () => {
  return {
    Client: class {
      login = vi.fn();
      on = vi.fn();
      channels = { fetch: vi.fn() };
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      MessageContent: 3,
    },
    REST: class {
      setToken = vi.fn().mockReturnThis();
      put = vi.fn();
    },
    Routes: {
      applicationCommands: vi.fn(),
    },
    SlashCommandBuilder: class {
      setName = vi.fn().mockReturnThis();
      setDescription = vi.fn().mockReturnThis();
      addStringOption = vi.fn().mockReturnThis();
      toJSON = vi.fn().mockReturnValue({});
    },
    WebhookClient: class {
      send = mockWebhookSend;
      editMessage = mockWebhookEditMessage;
      deleteMessage = mockWebhookDeleteMessage;
      delete = mockWebhookDelete;
    },
  };
});

vi.mock('serchat.ts', () => {
  return {
    Client: class {
      login = vi.fn();
      on = vi.fn();
      getServer = vi.fn().mockResolvedValue({ _id: 'SERVER', ownerId: 'not-the-user' });
      getRoles = vi.fn();
      hasPermission = vi.fn();
      webhooks = {
        createWebhook: vi.fn(),
        deleteWebhook: vi.fn(),
        executeWebhook: vi.fn(),
        editWebhookMessage: vi.fn(),
        deleteWebhookMessage: vi.fn(),
      };
      commands = {
        register: vi.fn(),
        sync: vi.fn(),
      };
      sendMessage = vi.fn();
      getRest = vi.fn().mockReturnValue({
        get: vi.fn().mockImplementation((url: string) => {
          if (url.includes('/profile/')) {
            const parts = url.split('/');
            const userId = parts[parts.length - 1];
            return Promise.resolve({
              profilePicture: 'api-avatar-url',
              username: `user-${userId}`,
              displayName: `Display-${userId}`,
            });
          }
          if (url.includes('/emojis/')) {
            const parts = url.split('/');
            const emojiId = parts[parts.length - 1];
            return Promise.resolve({
              name: `Emoji-${emojiId}`,
            });
          }
          if (url.includes('/messages/')) {
            const parts = url.split('/');
            const msgId = parts[parts.length - 1];
            if (msgId === 'parent-webhook-msg-id') {
              return Promise.resolve({
                message: {
                  messageId: msgId,
                  senderId: 'bot-user-id',
                  isWebhook: true,
                  webhookUsername: 'Cool Webhook',
                  text: 'I am a webhook message!',
                },
              });
            }
            return Promise.resolve({
              message: {
                messageId: msgId,
                senderId: 'reply-user-id',
                text: 'Replying to you!',
              },
            });
          }
          return Promise.resolve({
            profilePicture: 'api-avatar-url',
          });
        }),
      });
      getApiOrigin = vi.fn().mockReturnValue('http://localhost');
      user = { id: 'bot-id', username: 'Bridge Bot' };
    },
    LogLevel: {
      INFO: 'info',
    },
    BotCommand: class BotCommand {
      isMock = true;
    },
    unwrap: <T>(p: T): T => p,
  };
});

import {
  initDB,
  hasMutualAllowlist,
  ensureDiscordWebhook,
  ensureSerchatWebhook,
  refreshWebhookCache,
  knownSerchatWebhooks,
  discord,
  serchat,
  db,
} from './bridge';
import { knownDiscordWebhooks, cleanupExpiredRequests, purgeMessageMap, EXPIRY_MS } from './db';
import { CappedMap } from './serchat-handlers';

const discordEvents: Record<string, (...args: unknown[]) => unknown> = {};
const serchatEvents: Record<string, (...args: unknown[]) => unknown> = {};

interface MockOn {
  mock: { calls: [string, (...args: unknown[]) => unknown][] };
}

for (const call of (discord.on as unknown as MockOn).mock.calls) {
  discordEvents[call[0]] = call[1];
}
for (const call of (serchat.on as unknown as MockOn).mock.calls) {
  serchatEvents[call[0]] = call[1];
}

describe('Bridge Bot Utility Tests', () => {
  beforeEach(async () => {
    await initDB();
    await db.exec('DELETE FROM servers_allowlist');
    await db.exec('DELETE FROM bridges');
    await db.exec('DELETE FROM bridge_requests');
    await db.exec('DELETE FROM message_map');
    knownSerchatWebhooks.clear();
    knownDiscordWebhooks.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  it('hasMutualAllowlist should return true only if both sides explicitly allowed each other', async () => {
    await db.run(
      'INSERT INTO servers_allowlist (discord_server_id, serchat_server_id, added_by) VALUES (?, ?, ?)',
      ['D1', 's1', 'discord'],
    );
    await db.run(
      'INSERT INTO servers_allowlist (discord_server_id, serchat_server_id, added_by) VALUES (?, ?, ?)',
      ['D1', 's1', 'serchat'],
    );
    expect(await hasMutualAllowlist('D1', 'S1')).toBe(true);

    await db.run(
      'INSERT INTO servers_allowlist (discord_server_id, serchat_server_id, added_by) VALUES (?, ?, ?)',
      ['D2', 's2', 'discord'],
    );
    expect(await hasMutualAllowlist('D2', 'S2')).toBe(false);
  });

  it('refreshWebhookCache should populate knownSerchatWebhooks from DB', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC1', 'DS1', 'SC1', 'SS1', 'dw1', 'dt1', 'sw1'],
    );
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC2', 'DS2', 'SC2', 'SS2', 'dw2', 'dt2', 'sw2'],
    );

    await refreshWebhookCache();
    expect(knownSerchatWebhooks.size).toBe(2);
    expect(knownSerchatWebhooks.has('sw1')).toBe(true);
    expect(knownSerchatWebhooks.has('sw2')).toBe(true);
  });

  it('hasPermission should correctly verify admin based on roles', async () => {
    (serchat.hasPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
    expect(await serchat.hasPermission('SS1', 'User1', 'administrator')).toBe(true);

    (serchat.hasPermission as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    expect(await serchat.hasPermission('SS1', 'User2', 'administrator')).toBe(false);
  });

  it('ensureDiscordWebhook should return existing webhook if it exists', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC1', 'DS1', 'SC1', 'SS1', 'existing_dw_id', 'existing_dw_token', 'sw1'],
    );

    const hook = await ensureDiscordWebhook('DC1');
    expect(hook.id).toBe('existing_dw_id');
    expect(hook.token).toBe('existing_dw_token');
    expect(discord.channels.fetch).not.toHaveBeenCalled();
  });

  it('ensureDiscordWebhook should create new webhook if not exists', async () => {
    discord.channels.fetch = vi.fn().mockResolvedValue({
      createWebhook: vi.fn().mockResolvedValue({
        id: 'new_dw_id',
        token: 'new_dw_token',
      }),
    });

    const hook = await ensureDiscordWebhook('DC_NEW');
    expect(hook.id).toBe('new_dw_id');
    expect(hook.token).toBe('new_dw_token');
    expect(discord.channels.fetch).toHaveBeenCalledWith('DC_NEW');
  });

  it('ensureSerchatWebhook should return existing webhook if it exists', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC1', 'DS1', 'SC1', 'SS1', 'dw1', 'dt1', 'existing_sw_id'],
    );

    const token = await ensureSerchatWebhook('SS1', 'SC1');
    expect(token).toBe('existing_sw_id');
    expect(serchat.webhooks.createWebhook).not.toHaveBeenCalled();
  });

  it('ensureSerchatWebhook should create new webhook if not exists', async () => {
    serchat.webhooks.createWebhook = vi.fn().mockResolvedValue({
      token: 'new_sw_token',
    });

    const token = await ensureSerchatWebhook('SS_NEW', 'SC_NEW');
    expect(token).toBe('new_sw_token');
    expect(serchat.webhooks.createWebhook).toHaveBeenCalledWith('SS_NEW', 'SC_NEW', {
      name: 'Discord Bridge',
    });
  });

  it('refreshWebhookCache should populate knownDiscordWebhooks from DB', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC1', 'DS1', 'SC1', 'SS1', 'dw1', 'dt1', 'sw1'],
    );

    await refreshWebhookCache();
    expect(knownDiscordWebhooks.size).toBe(1);
    expect(knownDiscordWebhooks.has('dw1')).toBe(true);
  });

  it('cleanupExpiredRequests should delete old pending requests but keep new ones', async () => {
    const now = Date.now();
    const oldTime = now - (EXPIRY_MS + 60 * 1000);
    const newTime = now - 10 * 60 * 1000;

    await db.run(
      'INSERT INTO bridge_requests (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, status, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_OLD', 'DS_OLD', 'SC_OLD', 'SS_OLD', 'pending_serchat', 'discord', oldTime],
    );
    await db.run(
      'INSERT INTO bridge_requests (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, status, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_NEW', 'DS_NEW', 'SC_NEW', 'SS_NEW', 'pending_serchat', 'discord', newTime],
    );

    await cleanupExpiredRequests();

    const pending = await db.all('SELECT * FROM bridge_requests');
    expect(pending.length).toBe(1);
    expect(pending[0].discord_channel_id).toBe('DC_NEW');
  });

  it('purgeMessageMap should delete message mappings for a removed bridge', async () => {
    await db.run(
      'INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'm1', 'serchat', 'SC1', 'wm1'],
    );
    await db.run(
      'INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)',
      ['serchat', 'm2', 'discord', 'DC1', 'wm2'],
    );
    await db.run(
      'INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)',
      ['serchat', 'm3', 'discord', 'DC_OTHER', 'wm3'],
    );

    await purgeMessageMap('DC1', 'SC1');

    const remaining = await db.all('SELECT * FROM message_map');
    expect(remaining.length).toBe(1);
    expect(remaining[0].source_message_id).toBe('m3');
  });

  it('CappedMap should enforce capacity limit and keep elements in MRU order', () => {
    const cache = new CappedMap<string, string>(3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');

    cache.get('a');

    cache.set('d', '4');

    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('bridges table should enforce unique constraint on discord_channel_id and serchat_channel_id', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC1', 'DS1', 'SC1', 'SS1', 'dw1', 'dt1', 'sw1'],
    );

    await expect(
      db.run(
        'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['DC1', 'DS1', 'SC2', 'SS1', 'dw2', 'dt2', 'sw2'],
      ),
    ).rejects.toThrow();

    await expect(
      db.run(
        'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['DC2', 'DS1', 'SC1', 'SS1', 'dw2', 'dt2', 'sw2'],
      ),
    ).rejects.toThrow();
  });

  it('should forward a Discord message to Serchat via webhook', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD', 'DS1', 'SC_FORWARD', 'SS1', 'dw1', 'dt1', 'sw1'],
    );

    serchat.webhooks.executeWebhook = vi.fn().mockResolvedValue({ id: 'sw_msg_id' });

    const discordMessageCreate = discordEvents['messageCreate'];
    expect(discordMessageCreate).toBeDefined();

    const mockMsg = {
      author: { bot: false, username: 'test-user', displayAvatarURL: () => 'avatar-url' },
      channel: { id: 'DC_FORWARD' },
      content: 'Hello world! <@545562211393732618> and <@999999999>',
      id: 'm1',
      attachments: {
        size: 1,
        values: () => [{ url: 'https://cdn.discordapp.com/attachments/123/456/test.png' }],
      },
      mentions: {
        members: {
          get: (id: string) => {
            if (id === '545562211393732618') {
              return { displayName: 'ServalNickname', user: { username: 'serval-username' } };
            }
            return undefined;
          },
        },
        users: {
          get: (id: string) => {
            if (id === '999999999') {
              return { username: 'fallback-user' };
            }
            return undefined;
          },
        },
      },
    };

    await discordMessageCreate(mockMsg as unknown);

    expect(serchat.webhooks.executeWebhook).toHaveBeenCalledWith('sw1', {
      content:
        'Hello world! @ServalNickname and @fallback-user\n[Attachment 1](https://cdn.discordapp.com/attachments/123/456/test.png)',
      username: 'test-user',
      avatarUrl: 'avatar-url',
    });

    const mapped = await db.get('SELECT * FROM message_map WHERE source_message_id = "m1"');
    expect(mapped).toBeDefined();
    expect(mapped.target_webhook_message_id).toBe('sw_msg_id');
  });

  it('should suppress embeds for URLs from a replied-to Discord message', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD', 'DS1', 'SC_FORWARD', 'SS1', 'dw1', 'dt1', 'sw1'],
    );

    serchat.webhooks.executeWebhook = vi.fn().mockResolvedValue({ id: 'sw_msg_id' });

    const repliedTo = {
      author: { username: 'reply-user' },
      member: { displayName: 'Reply User' },
      content: 'Look at https://example.com/page and https://ser.chat',
      attachments: {
        values: () => [{ url: 'https://cdn.discordapp.com/attachments/reply/image.png' }],
      },
      mentions: {
        members: { get: () => undefined },
        users: { get: () => undefined },
      },
    };

    const mockMsg = {
      author: { bot: false, username: 'test-user', displayAvatarURL: () => 'avatar-url' },
      channel: {
        id: 'DC_FORWARD',
        messages: { fetch: vi.fn().mockResolvedValue(repliedTo) },
      },
      content: 'My reply',
      id: 'm-reply',
      reference: { messageId: 'discord-parent' },
      attachments: { size: 0, values: () => [] },
      mentions: {
        members: { get: () => undefined },
        users: { get: () => undefined },
      },
    };

    const discordMessageCreate = discordEvents['messageCreate'];
    expect(discordMessageCreate).toBeDefined();
    await discordMessageCreate(mockMsg as unknown);

    expect(serchat.webhooks.executeWebhook).toHaveBeenCalledWith('sw1', {
      content:
        '> **Reply User**: Look at https://example.com/page and https://ser.chat\nMy reply',
      username: 'test-user',
      avatarUrl: 'avatar-url',
      noEmbedsUrls: [
        'https://example.com/page',
        'https://ser.chat',
        'https://cdn.discordapp.com/attachments/reply/image.png',
      ],
    });
  });

  it('should forward a Discord forwarded-message snapshot to Serchat', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD', 'DS1', 'SC_FORWARD', 'SS1', 'dw1', 'dt1', 'sw1'],
    );

    serchat.webhooks.executeWebhook = vi.fn().mockResolvedValue({ id: 'sw_msg_id' });

    const forwarded = {
      content: 'Forwarded hello <@545562211393732618> https://example.com/forwarded',
      attachments: {
        size: 1,
        values: () => [{ url: 'https://cdn.discordapp.com/attachments/forwarded/image.png' }],
      },
      mentions: {
        members: {
          get: (id: string) => {
            if (id === '545562211393732618') {
              return { displayName: 'Forwarded User', user: { username: 'forwarded-user' } };
            }
            return undefined;
          },
        },
        users: { get: () => undefined },
      },
    };

    const mockMsg = {
      author: { bot: false, username: 'test-user', displayAvatarURL: () => 'avatar-url' },
      channel: {
        id: 'DC_FORWARD',
        messages: { fetch: vi.fn() },
      },
      content: '',
      id: 'm-forward',
      reference: { messageId: 'discord-forwarded-parent', type: 1 },
      messageSnapshots: { first: () => forwarded },
      attachments: { size: 0, values: () => [] },
      mentions: {
        members: { get: () => undefined },
        users: { get: () => undefined },
      },
    };

    const discordMessageCreate = discordEvents['messageCreate'];
    expect(discordMessageCreate).toBeDefined();
    await discordMessageCreate(mockMsg as unknown);

    expect(mockMsg.channel.messages.fetch).not.toHaveBeenCalled();
    expect(serchat.webhooks.executeWebhook).toHaveBeenCalledWith('sw1', {
      content:
        '> **Forwarded by test-user**: Forwarded hello @Forwarded User https://example.com/forwarded\n> [Forwarded attachment 1](https://cdn.discordapp.com/attachments/forwarded/image.png)',
      username: 'test-user',
      avatarUrl: 'avatar-url',
      noEmbedsUrls: [
        'https://example.com/forwarded',
        'https://cdn.discordapp.com/attachments/forwarded/image.png',
      ],
    });
  });

  it('should forward a Serchat message to Discord via webhook', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD', 'DS1', 'SC_FORWARD', 'SS1', 'dw1', 'dt1', 'sw1'],
    );

    mockWebhookSend.mockClear();

    const serchatMessageCreate = serchatEvents['messageCreate'];
    expect(serchatMessageCreate).toBeDefined();

    const mockMsg = {
      senderId: 'user1',
      senderUsername: 'test-user',
      serverId: 'SS1',
      channelId: 'SC_FORWARD',
      text: 'Hello Serchat! <userid:\'690cd6f250f11be9566ea1ea\'> and <emoji:6a00c3c239e601dbb84880f5>',
      messageId: 'sm1',
      replyToId: 'parent-msg-id',
      attachments: [
        {
          attachmentId: 'file123.png',
          type: 'image',
          mimeType: 'image/png',
          name: 'file123.png',
          size: 12345,
        },
      ],
      isWebhook: false,
      hasAttachments: () => true,
      getAttachmentUrl: (a: { attachmentId: string }) =>
        `http://localhost/api/v1/files/download/${a.attachmentId}`,
    };

    await serchatMessageCreate(mockMsg);

    expect(mockWebhookSend).toHaveBeenCalledWith({
      content: '> **Display-reply-user-id**: Replying to you!\nHello Serchat! @Display-690cd6f250f11be9566ea1ea and :Emoji-6a00c3c239e601dbb84880f5:\nhttp://localhost/api/v1/files/download/file123.png',
      username: 'test-user',
      avatarURL: 'http://localhostapi-avatar-url',
      allowedMentions: { parse: [] },
    });

    const mapped = await db.get('SELECT * FROM message_map WHERE source_message_id = "sm1"');
    expect(mapped).toBeDefined();
    expect(mapped.target_webhook_message_id).toBe('dw_msg_id');
  });

  it('should forward a Serchat message to Discord via webhook and resolve parent webhook name in replies', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD_WEBHOOK', 'DS1', 'SC_FORWARD_WEBHOOK', 'SS1', 'dw2', 'dt2', 'sw2'],
    );

    mockWebhookSend.mockClear();

    const serchatMessageCreate = serchatEvents['messageCreate'];
    expect(serchatMessageCreate).toBeDefined();

    const mockMsg = {
      senderId: 'user1',
      senderUsername: 'test-user',
      serverId: 'SS1',
      channelId: 'SC_FORWARD_WEBHOOK',
      text: 'Replying to webhooks rule!',
      messageId: 'sm2',
      replyToId: 'parent-webhook-msg-id',
      attachments: [],
      isWebhook: false,
      hasAttachments: () => false,
    };

    await serchatMessageCreate(mockMsg);

    expect(mockWebhookSend).toHaveBeenCalledWith({
      content: '> **Cool Webhook**: I am a webhook message!\nReplying to webhooks rule!',
      username: 'test-user',
      avatarURL: 'http://localhostapi-avatar-url',
      allowedMentions: { parse: [] },
    });

    const mapped = await db.get('SELECT * FROM message_map WHERE source_message_id = "sm2"');
    expect(mapped).toBeDefined();
    expect(mapped.target_webhook_message_id).toBe('dw_msg_id');
  });

  it('should delete the Serchat webhook message when a bridged Discord message is deleted', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD', 'DS1', 'SC_FORWARD', 'SS1', 'dw1', 'dt1', 'sw1'],
    );
    await db.run(
      'INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'discord-delete-1', 'serchat', 'SC_FORWARD', 'serchat-webhook-message-1'],
    );

    serchat.webhooks.deleteWebhookMessage = vi.fn().mockResolvedValue({});

    const discordMessageDelete = discordEvents['messageDelete'];
    expect(discordMessageDelete).toBeDefined();
    await discordMessageDelete({ id: 'discord-delete-1' } as unknown);

    expect(serchat.webhooks.deleteWebhookMessage).toHaveBeenCalledWith(
      'sw1',
      'serchat-webhook-message-1',
    );
    const mapped = await db.get(
      'SELECT * FROM message_map WHERE source_message_id = "discord-delete-1"',
    );
    expect(mapped).toBeUndefined();
  });

  it('should delete Serchat webhook messages when bridged Discord messages are bulk deleted', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD', 'DS1', 'SC_FORWARD', 'SS1', 'dw1', 'dt1', 'sw1'],
    );
    await db.run(
      'INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'discord-bulk-1', 'serchat', 'SC_FORWARD', 'serchat-webhook-message-1'],
    );
    await db.run(
      'INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)',
      ['discord', 'discord-bulk-2', 'serchat', 'SC_FORWARD', 'serchat-webhook-message-2'],
    );

    serchat.webhooks.deleteWebhookMessage = vi.fn().mockResolvedValue({});

    const discordMessageDeleteBulk = discordEvents['messageDeleteBulk'];
    expect(discordMessageDeleteBulk).toBeDefined();
    await discordMessageDeleteBulk(
      new Map([
        ['discord-bulk-1', { id: 'discord-bulk-1' }],
        ['discord-bulk-2', { id: 'discord-bulk-2' }],
      ]) as unknown,
    );

    expect(serchat.webhooks.deleteWebhookMessage).toHaveBeenCalledWith(
      'sw1',
      'serchat-webhook-message-1',
    );
    expect(serchat.webhooks.deleteWebhookMessage).toHaveBeenCalledWith(
      'sw1',
      'serchat-webhook-message-2',
    );
    const remaining = await db.all(
      'SELECT * FROM message_map WHERE source_message_id IN ("discord-bulk-1", "discord-bulk-2")',
    );
    expect(remaining).toHaveLength(0);
  });

  it('should delete the Discord webhook message when a bridged Serchat message is deleted', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD', 'DS1', 'SC_FORWARD', 'SS1', 'dw1', 'dt1', 'sw1'],
    );
    await db.run(
      'INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)',
      ['serchat', 'serchat-delete-1', 'discord', 'DC_FORWARD', 'discord-webhook-message-1'],
    );

    const serchatMessageDelete = serchatEvents['messageDelete'];
    expect(serchatMessageDelete).toBeDefined();
    await serchatMessageDelete({ messageId: 'serchat-delete-1' } as unknown);

    expect(mockWebhookDeleteMessage).toHaveBeenCalledWith('discord-webhook-message-1');
    const mapped = await db.get(
      'SELECT * FROM message_map WHERE source_message_id = "serchat-delete-1"',
    );
    expect(mapped).toBeUndefined();
  });

  it('should delete Discord webhook messages when bridged Serchat messages are bulk deleted', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD', 'DS1', 'SC_FORWARD', 'SS1', 'dw1', 'dt1', 'sw1'],
    );
    await db.run(
      'INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)',
      ['serchat', 'serchat-bulk-1', 'discord', 'DC_FORWARD', 'discord-webhook-message-1'],
    );
    await db.run(
      'INSERT INTO message_map (source_platform, source_message_id, target_platform, target_channel_id, target_webhook_message_id) VALUES (?, ?, ?, ?, ?)',
      ['serchat', 'serchat-bulk-2', 'discord', 'DC_FORWARD', 'discord-webhook-message-2'],
    );

    const serchatMessageBulkDelete = serchatEvents['messageBulkDelete'];
    expect(serchatMessageBulkDelete).toBeDefined();
    await serchatMessageBulkDelete({
      messageIds: ['serchat-bulk-1', 'serchat-bulk-2'],
    } as unknown);

    expect(mockWebhookDeleteMessage).toHaveBeenCalledWith('discord-webhook-message-1');
    expect(mockWebhookDeleteMessage).toHaveBeenCalledWith('discord-webhook-message-2');
    const remaining = await db.all(
      'SELECT * FROM message_map WHERE source_message_id IN ("serchat-bulk-1", "serchat-bulk-2")',
    );
    expect(remaining).toHaveLength(0);
  });

  it('should complete handshake when a Serchat admin types accept exactly', async () => {
    serchat.hasPermission = vi.fn().mockResolvedValue(true);

    await db.run(
      'INSERT INTO bridge_requests (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, status, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_PENDING', 'DS1', 'SC_PENDING', 'ss1', 'pending_serchat', 'discord', Date.now()],
    );

    discord.channels.fetch = vi.fn().mockResolvedValue({
      createWebhook: vi.fn().mockResolvedValue({ id: 'dw1', token: 'dt1' }),
      isTextBased: () => true,
      send: vi.fn(),
    });
    serchat.webhooks.createWebhook = vi.fn().mockResolvedValue({ token: 'sw1' });

    const serchatMessageCreate = serchatEvents['messageCreate'];
    expect(serchatMessageCreate).toBeDefined();

    const mockMsg = {
      senderId: 'admin1',
      serverId: 'SS1',
      channelId: 'SC_PENDING',
      text: 'accept',
      reply: vi.fn(),
      isWebhook: false,
    };

    await serchatMessageCreate(mockMsg);

    const bridge = await db.get('SELECT * FROM bridges WHERE discord_channel_id = "DC_PENDING"');
    expect(bridge).toBeDefined();
    expect(bridge.serchat_webhook_id).toBe('sw1');

    const req = await db.get(
      'SELECT * FROM bridge_requests WHERE discord_channel_id = "DC_PENDING"',
    );
    expect(req).toBeUndefined();
  });

  it('should complete handshake when a Serchat admin executes accept-bridge command', async () => {
    const serchatReady = serchatEvents['ready'];
    await serchatReady();

    interface MockCommand {
      name: string;
      execute: (interaction: unknown) => Promise<void>;
    }
    const registerMock = serchat.commands.register as unknown as {
      mock: { calls: MockCommand[][] };
    };
    const registeredCommands = registerMock.mock.calls.map((c) => c[0]);
    const acceptCmd = registeredCommands.find((c) => c.name === 'accept-bridge');
    expect(acceptCmd).toBeDefined();

    await db.run(
      'INSERT INTO bridge_requests (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, status, initiated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_CMD', 'DS1', 'SC_CMD', 'ss1', 'pending_serchat', 'discord', Date.now()],
    );

    discord.channels.fetch = vi.fn().mockResolvedValue({
      createWebhook: vi.fn().mockResolvedValue({ id: 'dw1', token: 'dt1' }),
      isTextBased: () => true,
      send: vi.fn(),
    });
    serchat.webhooks.createWebhook = vi.fn().mockResolvedValue({ token: 'sw1' });

    const req = await db.get('SELECT id FROM bridge_requests WHERE discord_channel_id = "DC_CMD"');

    const mockInteraction = {
      serverId: 'SS1',
      channelId: 'SC_CMD',
      hasPermission: vi.fn().mockReturnValue(true),
      getString: vi.fn().mockReturnValue(String(req.id)),
      reply: vi.fn(),
    };

    await acceptCmd!.execute(mockInteraction);

    const bridge = await db.get('SELECT * FROM bridges WHERE discord_channel_id = "DC_CMD"');
    expect(bridge).toBeDefined();
    expect(bridge.serchat_webhook_id).toBe('sw1');
  });

  it('should not forward a Discord message to Serchat if it contains a sticker or poll', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD', 'DS1', 'SC_FORWARD', 'SS1', 'dw1', 'dt1', 'sw1'],
    );

    serchat.webhooks.executeWebhook = vi.fn();

    const discordMessageCreate = discordEvents['messageCreate'];
    expect(discordMessageCreate).toBeDefined();

    const mockMsgSticker = {
      author: { bot: false, username: 'test-user', displayAvatarURL: () => 'avatar-url' },
      channel: { id: 'DC_FORWARD' },
      content: 'I sent a sticker!',
      id: 'm-sticker',
      stickers: { size: 1 },
    };

    await discordMessageCreate(mockMsgSticker as unknown);
    expect(serchat.webhooks.executeWebhook).not.toHaveBeenCalled();

    const mockMsgPoll = {
      author: { bot: false, username: 'test-user', displayAvatarURL: () => 'avatar-url' },
      channel: { id: 'DC_FORWARD' },
      content: 'I sent a poll!',
      id: 'm-poll',
      poll: {},
    };

    await discordMessageCreate(mockMsgPoll as unknown);
    expect(serchat.webhooks.executeWebhook).not.toHaveBeenCalled();
  });

  it('should not forward a Serchat message to Discord if it contains a sticker or poll', async () => {
    await db.run(
      'INSERT INTO bridges (discord_channel_id, discord_server_id, serchat_channel_id, serchat_server_id, discord_webhook_id, discord_webhook_token, serchat_webhook_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['DC_FORWARD', 'DS1', 'SC_FORWARD', 'SS1', 'dw1', 'dt1', 'sw1'],
    );

    mockWebhookSend.mockClear();

    const serchatMessageCreate = serchatEvents['messageCreate'];
    expect(serchatMessageCreate).toBeDefined();

    const mockMsgSticker = {
      senderId: 'user1',
      senderUsername: 'test-user',
      serverId: 'SS1',
      channelId: 'SC_FORWARD',
      text: 'I sent a sticker!',
      messageId: 'sm-sticker',
      stickerId: 'sticker-123',
      attachments: [],
      isWebhook: false,
    };

    await serchatMessageCreate(mockMsgSticker as unknown);
    expect(mockWebhookSend).not.toHaveBeenCalled();

    const mockMsgPoll = {
      senderId: 'user1',
      senderUsername: 'test-user',
      serverId: 'SS1',
      channelId: 'SC_FORWARD',
      text: 'I sent a poll!',
      messageId: 'sm-poll',
      poll: {},
      attachments: [],
      isWebhook: false,
    };

    await serchatMessageCreate(mockMsgPoll as unknown);
    expect(mockWebhookSend).not.toHaveBeenCalled();
  });
});
