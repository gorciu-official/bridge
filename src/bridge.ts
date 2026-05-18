import {
  Client as DiscordClient,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { Client as SerchatClient, LogLevel } from 'serchat.ts';
import { config } from 'dotenv';
import {
  initDB,
  db,
  refreshWebhookCache,
  knownSerchatWebhooks,
  hasMutualAllowlist,
  cleanupExpiredRequests,
} from './db';
import {
  ensureDiscordWebhook as ensureDiscordWebhookImpl,
  setupDiscordHandlers,
} from './discord-handlers';
import {
  ensureSerchatWebhook as ensureSerchatWebhookImpl,
  setupSerchatHandlers,
} from './serchat-handlers';

config();

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, SERCHAT_TOKEN } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID || !SERCHAT_TOKEN) {
  if (process.env.NODE_ENV !== 'test') {
    console.error('Missing required environment variables in .env');
    process.exit(1);
  }
}

const discord = new DiscordClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const serchat = new SerchatClient({
  logLevel: LogLevel.INFO,
});

const discordCommands = [
  new SlashCommandBuilder()
    .setName('allow-bridging')
    .setDescription('Allow bridging with Serchat')
    .addStringOption((option) =>
      option.setName('serchatserverid').setDescription('Serchat Server ID').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('configure-bridge')
    .setDescription('Configure a bridge to a Serchat channel')
    .addStringOption((option) =>
      option.setName('discordchannelid').setDescription('Discord Channel ID').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('serchatchannelid').setDescription('Serchat Channel ID').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('serchatserverid').setDescription('Serchat Server ID').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('remove-bridge')
    .setDescription('Remove an existing bridge')
    .addStringOption((option) =>
      option.setName('discordchannelid').setDescription('Discord Channel ID').setRequired(true),
    )
    .addStringOption((option) =>
      option.setName('serchatchannelid').setDescription('Serchat Channel ID').setRequired(true),
    ),
].map((command) => command.toJSON());

async function registerDiscordCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);
  try {
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID!), { body: discordCommands });
    console.log('[Discord] Successfully registered application commands.');
  } catch (error: unknown) {
    console.error('[Discord] Error registering commands:', error);
  }
}

discord.on('ready', () => {
  console.log(`[Discord] Logged in as ${discord.user?.tag}`);
  registerDiscordCommands().catch(console.error);
});

setupDiscordHandlers(discord, serchat);
setupSerchatHandlers(discord, serchat);

discord.on('error', (error) => {
  console.error('[Discord] Client error:', error);
});

discord.on('shardError', (error, shardId) => {
  console.error(`[Discord] Shard ${shardId} error:`, error);
});

discord.on('shardDisconnect', (event, shardId) => {
  console.warn(
    `[Discord] Shard ${shardId} disconnected (code: ${event.code}, reason: ${event.reason || 'None'})`,
  );
});

discord.on('shardReconnecting', (shardId) => {
  console.warn(`[Discord] Shard ${shardId} reconnecting...`);
});

discord.on('shardResume', (shardId, replayedEvents) => {
  console.log(`[Discord] Shard ${shardId} resumed (${replayedEvents} replayed events).`);
});

serchat.on('disconnect', () => {
  console.warn('[Serchat] WebSocket disconnected; reconnect scheduled by SDK.');
});

serchat.on('reconnected', () => {
  console.log('[Serchat] WebSocket reconnected.');
});

serchat.on('error', (error) => {
  console.error('[Serchat] Client error:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[Process] Uncaught exception:', error);
});

async function start() {
  await initDB();
  console.log('[App] Database initialized.');

  setInterval(
    () => {
      cleanupExpiredRequests().catch((err) =>
        console.error('[Cleanup] Error running periodic request cleanup:', err),
      );
    },
    60 * 60 * 1000,
  );

  discord.login(DISCORD_TOKEN!).catch(console.error);
  serchat.login(SERCHAT_TOKEN!).catch(console.error);
}

if (process.env.NODE_ENV !== 'test') {
  start().catch(console.error);
}

export async function ensureDiscordWebhook(channelId: string) {
  return ensureDiscordWebhookImpl(discord, channelId);
}

export async function ensureSerchatWebhook(serverId: string, channelId: string) {
  return ensureSerchatWebhookImpl(serchat, serverId, channelId);
}

export {
  initDB,
  hasMutualAllowlist,
  refreshWebhookCache,
  discord,
  serchat,
  knownSerchatWebhooks,
  db,
};
