import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

export let db: Database<sqlite3.Database, sqlite3.Statement> | undefined;
export const knownSerchatWebhooks = new Set<string>();
export const knownDiscordWebhooks = new Set<string>();

export const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

const rateLimits = new Map<string, number[]>();
export function isRateLimited(channelId: string): boolean {
  const now = Date.now();
  let timestamps = rateLimits.get(channelId) ?? [];
  timestamps = timestamps.filter(t => now - t < 1000);
  if (timestamps.length >= 5) {
    return true;
  }
  timestamps.push(now);
  rateLimits.set(channelId, timestamps);
  return false;
}

export async function refreshWebhookCache(): Promise<void> {
  knownSerchatWebhooks.clear();
  knownDiscordWebhooks.clear();
  if (!db) return;
  const bridges = await db.all('SELECT serchat_webhook_id, discord_webhook_id FROM bridges');
  for (const bridge of bridges) {
    if (typeof bridge.serchat_webhook_id === 'string') {
      knownSerchatWebhooks.add(bridge.serchat_webhook_id);
    }
    if (typeof bridge.discord_webhook_id === 'string') {
      knownDiscordWebhooks.add(bridge.discord_webhook_id);
    }
  }
}

export async function initDB(): Promise<void> {
  db = await open({
    filename: './bridge.sqlite',
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS servers_allowlist(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_server_id TEXT,
      serchat_server_id TEXT,
      added_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_requests(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_channel_id TEXT NOT NULL,
      discord_server_id TEXT NOT NULL,
      serchat_channel_id TEXT NOT NULL,
      serchat_server_id TEXT NOT NULL,
      status TEXT NOT NULL,
      initiated_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridges(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_channel_id TEXT NOT NULL,
      discord_server_id TEXT NOT NULL,
      serchat_channel_id TEXT NOT NULL,
      serchat_server_id TEXT NOT NULL,
      discord_webhook_id TEXT NOT NULL,
      discord_webhook_token TEXT NOT NULL,
      serchat_webhook_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_map(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_platform TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      target_platform TEXT NOT NULL,
      target_channel_id TEXT NOT NULL,
      target_webhook_message_id TEXT NOT NULL
    );
  `);

  await db.exec(`
    DELETE FROM servers_allowlist
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM servers_allowlist
      GROUP BY discord_server_id, serchat_server_id, added_by
    );

    DELETE FROM bridges
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM bridges
      GROUP BY discord_channel_id
    );

    DELETE FROM bridges
    WHERE rowid NOT IN (
      SELECT MIN(rowid)
      FROM bridges
      GROUP BY serchat_channel_id
    );
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_map_source ON message_map(source_platform, source_message_id);
    CREATE INDEX IF NOT EXISTS idx_bridges_discord_channel ON bridges(discord_channel_id);
    CREATE INDEX IF NOT EXISTS idx_bridges_serchat_channel ON bridges(serchat_channel_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridges_discord_channel_uniq ON bridges(discord_channel_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridges_serchat_channel_uniq ON bridges(serchat_channel_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_allowlist_pair ON servers_allowlist(discord_server_id, serchat_server_id, added_by);
  `);

  await refreshWebhookCache();
  await cleanupExpiredRequests();
}

export async function hasMutualAllowlist(
  discordServerId: string,
  serchatServerId: string,
): Promise<boolean> {
  const normalizedDiscordServerId = discordServerId.trim();
  const normalizedSerchatServerId = serchatServerId.trim().toLowerCase();

  const discordRow = await db!.get(
    'SELECT id FROM servers_allowlist WHERE added_by = "discord" AND discord_server_id = ? AND serchat_server_id = ?',
    [normalizedDiscordServerId, normalizedSerchatServerId],
  );

  const serchatRow = await db!.get(
    'SELECT id FROM servers_allowlist WHERE added_by = "serchat" AND serchat_server_id = ? AND discord_server_id = ?',
    [normalizedSerchatServerId, normalizedDiscordServerId],
  );

  return !!discordRow && !!serchatRow;
}

export async function cleanupExpiredRequests(): Promise<void> {
  if (!db) return;
  const cutoff = Date.now() - EXPIRY_MS;
  await db.run('DELETE FROM bridge_requests WHERE status = "pending_serchat" AND created_at < ?', [
    cutoff,
  ]);
}

export async function purgeMessageMap(
  discordChannelId: string,
  serchatChannelId: string,
): Promise<void> {
  if (!db) return;
  // Deletes all message mappings for the deleted bridge:
  // - For Discord->Serchat: source_platform = 'discord', target_channel_id = serchatChannelId
  // - For Serchat->Discord: source_platform = 'serchat', target_channel_id = discordChannelId
  await db.run(
    'DELETE FROM message_map WHERE (source_platform = "discord" AND target_channel_id = ?) OR (source_platform = "serchat" AND target_channel_id = ?)',
    [serchatChannelId, discordChannelId],
  );
}
