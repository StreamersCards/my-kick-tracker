import puppeteer from 'puppeteer';
import sqlite3 from 'sqlite3';

const db = new sqlite3.Database('./kick_tracker.db');

// Promisified DB helpers
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Database Initializer
async function initDb() {
  try {
    // 1. Core channels table: create only if missing, never drop existing data.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        current_slug TEXT UNIQUE,
        current_username TEXT,
        followers_count INTEGER DEFAULT 0,
        is_banned INTEGER DEFAULT 0,
        verified INTEGER DEFAULT 0,
        subscription_enabled INTEGER DEFAULT 0,
        vod_enabled INTEGER DEFAULT 0,
        livestream_title TEXT,
        bio TEXT,
        instagram TEXT,
        twitter TEXT,
        youtube TEXT,
        discord TEXT,
        tiktok TEXT,
        facebook TEXT,
        profile_pic TEXT,
        raw_payload TEXT,
        last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Safely migrate existing tables: only add columns that do not exist yet.
    const existingColumns = await allQuery('PRAGMA table_info(channels)');
    const existingColumnNames = new Set(existingColumns.map(col => col.name));
    const columnsToAdd = [
      { name: 'bio', type: 'TEXT' },
      { name: 'instagram', type: 'TEXT' },
      { name: 'twitter', type: 'TEXT' },
      { name: 'youtube', type: 'TEXT' },
      { name: 'discord', type: 'TEXT' },
      { name: 'tiktok', type: 'TEXT' },
      { name: 'facebook', type: 'TEXT' },
      { name: 'profile_pic', type: 'TEXT' },
      { name: 'subscription_enabled', type: 'INTEGER DEFAULT 0' },
      { name: 'vod_enabled', type: 'INTEGER DEFAULT 0' }
    ];

    for (const col of columnsToAdd) {
      if (!existingColumnNames.has(col.name)) {
        await runQuery(`ALTER TABLE channels ADD COLUMN ${col.name} ${col.type}`);
      }
    }

    // 2. Historical Username Tracker Table: keep old history forever.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS username_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER,
        slug TEXT,
        username TEXT,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(channel_id) REFERENCES channels(id)
      )
    `);

    // 3. Historical Socials Tracker Table: keep all previous social changes.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS socials_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER,
        field_name TEXT,
        old_value TEXT,
        new_value TEXT,
        detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(channel_id) REFERENCES channels(id)
      )
    `);

    // 4. Historical follower snapshots: keep every scrape for trend graphs.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS follower_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id INTEGER,
        followers_count INTEGER DEFAULT 0,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(channel_id) REFERENCES channels(id)
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS chat_users (
        user_id INTEGER PRIMARY KEY,
        current_slug TEXT,
        current_username TEXT,
        first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        raw_identity TEXT
      )
    `);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        message_id TEXT PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        sender_user_id INTEGER,
        sender_slug TEXT,
        sender_username TEXT,
        content TEXT,
        message_type TEXT,
        created_at TIMESTAMP,
        raw_payload TEXT,
        saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await runQuery(`
      INSERT INTO follower_history (channel_id, followers_count, recorded_at)
      SELECT c.id, COALESCE(c.followers_count, 0), CURRENT_TIMESTAMP
      FROM channels c
      WHERE NOT EXISTS (
        SELECT 1 FROM follower_history h WHERE h.channel_id = c.id
      )
    `);

    await repairCurrentFollowerSnapshots();

    await runQuery(`
      UPDATE channels
      SET is_banned = NULL
      WHERE is_banned = 0
        AND (
          raw_payload IS NULL
          OR raw_payload NOT LIKE '%"is_banned"%'
        )
    `);
  } catch (error) {
    console.error('[DB] Initialization failed:', error.message);
    throw error;
  }
}

function getPayloadFollowerCount(rawPayload) {
  if (!rawPayload) return null;
  try {
    const payload = JSON.parse(rawPayload);
    const value = payload.followersCount ?? payload.followers_count ?? payload.follower_count;
    const count = Number.parseInt(String(value ?? '').replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(count) ? count : null;
  } catch (error) {
    return null;
  }
}

async function repairCurrentFollowerSnapshots() {
  // One-time cleanup: collapse pre-existing spam (many rows per day) down to
  // the first snapshot per channel per day, so the DB shrinks and graphs stay clean.
  await runQuery(`
    DELETE FROM follower_history
    WHERE id NOT IN (
      SELECT MIN(id)
      FROM follower_history
      GROUP BY channel_id, DATE(recorded_at)
    )
  `);

  // One-time shrink: replace fat legacy channels.raw_payload blobs (~14KB avg)
  // with the slim form (~300B) going forward. Keeps is_banned-gated repair working
  // because the slim payload still contains the is_banned key.
  const fatChannels = await allQuery(`
    SELECT id, raw_payload FROM channels WHERE LENGTH(raw_payload) > 2000
  `);
  for (const channel of fatChannels) {
    let slim = null;
    try {
      const p = JSON.parse(channel.raw_payload);
      const u = p.user || {};
      const ls = p.livestream || null;
      slim = JSON.stringify({
        is_banned: p.is_banned ?? null,
        is_live: ls ? true : (p.is_live ?? null),
        verified: p.verified ? true : undefined,
        subscription_enabled: Boolean(p.subscription_enabled || p.is_affiliate),
        vod_enabled: Boolean(p.vod_enabled),
        vod_settings: p.vod_settings ? { enabled: Boolean(p.vod_settings.enabled) } : undefined,
        followersCount: Number.parseInt(String(p.followersCount ?? p.followers_count ?? 0), 10) || 0,
        followers_count: Number.parseInt(String(p.followersCount ?? p.followers_count ?? 0), 10) || 0,
        user: { profile_pic: u.profile_pic || null },
        livestream: ls ? {
          is_live: true,
          session_title: ls.session_title || null,
          title: ls.title || null,
          viewer_count: ls.viewer_count ?? null,
        } : null,
      });
    } catch {
      continue;
    }
    if (slim) await runQuery('UPDATE channels SET raw_payload = ? WHERE id = ?', [slim, channel.id]);
  }

  const channels = await allQuery(`
    SELECT id, followers_count, raw_payload
    FROM channels
    WHERE raw_payload IS NOT NULL
  `);

  for (const channel of channels) {
    const payloadCount = getPayloadFollowerCount(channel.raw_payload);
    if (payloadCount === null || payloadCount <= 0) continue;

    if (Number(channel.followers_count) !== payloadCount) {
      await runQuery('UPDATE channels SET followers_count = ? WHERE id = ?', [payloadCount, channel.id]);
    }

    const latestSnapshot = await getQuery(`
      SELECT followers_count, recorded_at
      FROM follower_history
      WHERE channel_id = ?
      ORDER BY recorded_at DESC, id DESC
      LIMIT 1
    `, [channel.id]);

    const today = new Date().toISOString().slice(0, 10);
    const latestDay = latestSnapshot?.recorded_at ? String(latestSnapshot.recorded_at).slice(0, 10) : null;

    if (!latestSnapshot || (Number(latestSnapshot.followers_count) !== payloadCount && latestDay !== today)) {
      await runQuery('INSERT INTO follower_history (channel_id, followers_count) VALUES (?, ?)', [channel.id, payloadCount]);
    }
  }
}

async function processChannelPayload(data) {
  if (!data || !data.id) return null;

  const channelId = data.id;
  const userObj = data.user || {};
  const userId = data.user_id || userObj.id || null;
  const newSlug = data.slug;
  const newUsername = userObj.username || newSlug;
  const followersCount = Number.parseInt(String(data.followersCount ?? data.followers_count ?? 0), 10) || 0;
  const isBanned = data.is_banned === undefined || data.is_banned === null ? null : (data.is_banned ? 1 : 0);
  const verified = data.verified ? 1 : 0;
  
  // Subscription / Monetized status check
  const subscriptionEnabled = (data.subscription_enabled || data.is_affiliate) ? 1 : 0;
  
  // Extract vod_enabled from data object or fallback check
  const vodEnabled = (data.vod_enabled === true || (data.vod_enabled !== false && data.vod_enabled !== 0)) ? 1 : 0;

  const livestreamTitle = data.livestream ? data.livestream.session_title : null;
  // Slim payload: keep only what the frontend/tracker actually read.
  // Drops the fat junk: previous_livestreams (~60%), playback_url (1KB JWT),
  // recent_categories banners/descriptions, subscriber_badges, ascending_links,
  // media/offline_banner srcsets, chatroom slow-mode flags.
  // NOTE: is_affiliate is already folded into subscriptionEnabled above, so it
  // is intentionally not kept here.
  const rawPayload = JSON.stringify({
    is_banned: data.is_banned ?? null,
    is_live: data.livestream ? true : (data.is_live ?? null),
    verified: data.verified ? true : undefined,
    subscription_enabled: Boolean(data.subscription_enabled || data.is_affiliate),
    vod_enabled: Boolean(data.vod_enabled),
    vod_settings: data.vod_settings ? { enabled: Boolean(data.vod_settings.enabled) } : undefined,
    followersCount,
    followers_count: followersCount,
    user: { profile_pic: userObj.profile_pic || null },
    livestream: data.livestream ? {
      is_live: true,
      session_title: data.livestream.session_title || null,
      title: data.livestream.title || null,
      viewer_count: data.livestream.viewer_count ?? null,
    } : null,
  });

  const bio = userObj.bio || "";
  const instagram = userObj.instagram || "";
  const twitter = userObj.twitter || "";
  const youtube = userObj.youtube || "";
  const discord = userObj.discord || "";
  const tiktok = userObj.tiktok || "";
  const facebook = userObj.facebook || "";
  const profilePic = userObj.profile_pic || "";

  const existing = await getQuery('SELECT * FROM channels WHERE id = ?', [channelId]);

  if (!existing) {
    await runQuery(`
      INSERT INTO channels (
        id, user_id, current_slug, current_username, followers_count,
        is_banned, verified, subscription_enabled, vod_enabled, livestream_title, bio, instagram, twitter,
        youtube, discord, tiktok, facebook, profile_pic, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      channelId, userId, newSlug, newUsername, followersCount,
      isBanned, verified, subscriptionEnabled, vodEnabled, livestreamTitle, bio, instagram, twitter,
      youtube, discord, tiktok, facebook, profilePic, rawPayload
    ]);

    await runQuery(`
      INSERT INTO username_history (channel_id, slug, username)
      VALUES (?, ?, ?)
    `, [channelId, newSlug, newUsername]);

    console.log(`[+] Tracked new channel: @${newSlug} (ID: ${channelId})`);
  } else {
    // Check for username / slug changes
    if (existing.current_slug !== newSlug || existing.current_username !== newUsername) {
      console.log(`[!] Handle change detected for ID ${channelId}: @${existing.current_slug} -> @${newSlug}`);
      await runQuery(`
        INSERT INTO username_history (channel_id, slug, username)
        VALUES (?, ?, ?)
      `, [channelId, newSlug, newUsername]);
    }

    // Check for social profile changes
    const socialFields = [
      { name: 'bio', val: bio },
      { name: 'instagram', val: instagram },
      { name: 'twitter', val: twitter },
      { name: 'youtube', val: youtube },
      { name: 'discord', val: discord },
      { name: 'tiktok', val: tiktok },
      { name: 'facebook', val: facebook }
    ];

    for (const field of socialFields) {
      const oldVal = existing[field.name] || "";
      if (oldVal !== field.val) {
        console.log(`[!] ${field.name} change for @${newSlug}: "${oldVal}" -> "${field.val}"`);
        await runQuery(`
          INSERT INTO socials_history (channel_id, field_name, old_value, new_value)
          VALUES (?, ?, ?, ?)
        `, [channelId, field.name, oldVal, field.val]);
      }
    }

    await runQuery(`
      UPDATE channels
      SET current_slug = ?, current_username = ?, followers_count = ?,
          is_banned = ?, verified = ?, subscription_enabled = ?, vod_enabled = ?, livestream_title = ?, bio = ?,
          instagram = ?, twitter = ?, youtube = ?, discord = ?,
          tiktok = ?, facebook = ?, profile_pic = ?, raw_payload = ?,
          last_updated = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      newSlug, newUsername, followersCount, isBanned, verified, subscriptionEnabled, vodEnabled,
      livestreamTitle, bio, instagram, twitter, youtube, discord,
      tiktok, facebook, profilePic, rawPayload, channelId
    ]);
  }

  // Follower snapshot: at most 1 row per channel per day, and only when the count changed.
  // This keeps graph history without spamming ~2,400 identical rows/day.
  const latestSnapshot = await getQuery(`
    SELECT followers_count, recorded_at
    FROM follower_history
    WHERE channel_id = ?
    ORDER BY recorded_at DESC, id DESC
    LIMIT 1
  `, [channelId]);

  const today = new Date().toISOString().slice(0, 10);
  const latestDay = latestSnapshot?.recorded_at ? String(latestSnapshot.recorded_at).slice(0, 10) : null;
  const countChanged = !latestSnapshot || Number(latestSnapshot.followers_count) !== followersCount;

  if (!latestSnapshot || (countChanged && latestDay !== today)) {
    await runQuery(`
      INSERT INTO follower_history (channel_id, followers_count)
      VALUES (?, ?)
    `, [channelId, followersCount]);
  }

  return channelId;
}

function isLiveChannelPayload(data) {
  const livestream = data?.livestream;
  const liveTitle = data?.livestream_title || livestream?.session_title || livestream?.title;
  const liveFlag = data?.is_live ?? data?.isLive ?? livestream?.is_live ?? livestream?.isLive;
  return liveFlag === true || liveFlag === 1 || Boolean(liveTitle) || Boolean(livestream && liveFlag !== false && liveFlag !== 0);
}

async function saveChatHistory(chatId, historyPayload) {
  const messages = Array.isArray(historyPayload?.data?.messages) ? historyPayload.data.messages : [];
  let savedMessages = 0;
  let discoveredUsers = 0;

  const uniqueSenders = new Map();
  for (const message of messages) {
    const sender = message.sender || {};
    const senderId = Number(sender.id || message.user_id) || null;
    if (senderId && !uniqueSenders.has(senderId)) uniqueSenders.set(senderId, sender);
  }

  for (const [senderId, sender] of uniqueSenders) {
    const existingUser = await getQuery('SELECT user_id FROM chat_users WHERE user_id = ?', [senderId]);
    await refreshChatUserChannel(sender, senderId);
    if (!existingUser) discoveredUsers += 1;
  }

  for (const message of messages) {
    const sender = message.sender || {};
    const senderId = Number(sender.id || message.user_id) || null;
    if (senderId) {
      const existingUser = await getQuery('SELECT user_id FROM chat_users WHERE user_id = ?', [senderId]);
      await runQuery(`
        INSERT INTO chat_users (user_id, current_slug, current_username, raw_identity, last_seen_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          current_slug = excluded.current_slug,
          current_username = excluded.current_username,
          raw_identity = excluded.raw_identity,
          last_seen_at = CURRENT_TIMESTAMP
      `, [senderId, sender.slug || null, sender.username || sender.slug || null, JSON.stringify(sender)]);
      if (!existingUser) discoveredUsers += 1;
    }

    if (!message.id) continue;
    // Slim chat payload: keep only the reply-chain fields the frontend renders
    // (getReplyChain/parseReplyMetadata). Drops the sender-identity echo (~700B → ~100B).
    // NOTE: chat_users.raw_identity keeps the full sender object (one row per user, tiny).
    const replySource = message.original_message
      || (typeof message.metadata === 'object' && message.metadata !== null ? message.metadata.original_message : null)
      || (() => { try {
        const meta = typeof message.metadata === 'string' ? JSON.parse(message.metadata) : null;
        return meta?.original_message || null;
      } catch { return null; } })();
    const slimChatPayload = JSON.stringify({
      id: message.id,
      content: message.content || '',
      created_at: message.created_at || null,
      sender: { id: senderId, username: sender.username || null, slug: sender.slug || null },
      ...(replySource ? { original_message: replySource } : {}),
      ...(typeof message.metadata === 'string' ? { metadata: message.metadata } : {}),
    });
    const result = await runQuery(`
      INSERT OR IGNORE INTO chat_messages (
        message_id, chat_id, sender_user_id, sender_slug, sender_username,
        content, message_type, created_at, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      message.id,
      chatId,
      senderId,
      sender.slug || null,
      sender.username || sender.slug || null,
      message.content || '',
      message.type || 'message',
      message.created_at || null,
      slimChatPayload
    ]);
    if (result.changes > 0) savedMessages += 1;
  }

  return { savedMessages, discoveredUsers };
}

async function refreshChatUserChannel(sender, senderId) {
  const existingChannel = await getQuery(`
    SELECT id, current_slug, current_username FROM channels
    WHERE user_id = ? OR LOWER(current_slug) = LOWER(?)
    LIMIT 1
  `, [senderId, sender.slug || '']);
  if (!sender.slug) return Boolean(existingChannel);

  try {
    const response = await fetch(`https://kick.com/api/v1/channels/${encodeURIComponent(sender.slug)}`, {
      headers: { 'User-Agent': 'KickIntel Tracker/1.0', Accept: 'application/json' }
    });
    if (!response.ok) return false;
    const payload = await response.json();
    if (!payload?.id) return false;
    await processChannelPayload(payload);
    if (!existingChannel) console.log(`[CHAT] Added chatter as tracked channel: @${payload.slug || sender.slug}`);
    return Boolean(existingChannel);
  } catch (error) {
    console.warn(`[CHAT] Could not add chatter @${sender.slug} as a channel:`, error.message);
    return false;
  }
}

async function fetchLiveChatHistory(data) {
  if (!isLiveChannelPayload(data)) return { savedMessages: 0, discoveredUsers: 0 };

  const chatId = Number(
    data.id || data.chat_id || data.chatroom_id || data.chatroom?.id || data.livestream?.chat_id || data.livestream?.chatroom_id || data.livestream?.chatroom?.id
  );
  if (!chatId) return { savedMessages: 0, discoveredUsers: 0 };

  const response = await fetch(`https://web.kick.com/api/v1/chat/${encodeURIComponent(chatId)}/history`, {
    headers: { 'User-Agent': 'KickIntel Tracker/1.0', Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Chat history returned ${response.status}`);
  const payload = await response.json();
  return saveChatHistory(chatId, payload);
}

function appendChatLog(tag, message) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync('./logz.txt', `${timestamp} [Chat][${tag}] ${message}\n`, 'utf8');
}

async function collectAndLogChat(data, fallbackTag) {
  const tag = data?.slug || fallbackTag || String(data?.id || 'unknown');
  const displayTag = tag.charAt(0).toUpperCase() + tag.slice(1);
  const live = isLiveChannelPayload(data);

  if (!live) {
    appendChatLog(displayTag, 'offline - messages added: 0, new users: 0');
    return { savedMessages: 0, discoveredUsers: 0 };
  }

  try {
    const result = await fetchLiveChatHistory(data);
    appendChatLog(displayTag, `live - messages added: ${result.savedMessages}, new users: ${result.discoveredUsers}`);
    return result;
  } catch (error) {
    appendChatLog(displayTag, `error - ${error.message}`);
    throw error;
  }
}

async function getKnownTrackedHandles() {
  const rows = await allQuery(`
    SELECT DISTINCT LOWER(current_slug) AS slug, LOWER(current_username) AS username
    FROM channels
    WHERE current_slug IS NOT NULL OR current_username IS NOT NULL
    UNION
    SELECT DISTINCT LOWER(slug), LOWER(username)
    FROM username_history
    WHERE slug IS NOT NULL OR username IS NOT NULL
  `);

  const tracked = new Set();

  for (const row of rows) {
    if (row.slug) tracked.add(String(row.slug).trim().replace(/^@/, ''));
    if (row.username) tracked.add(String(row.username).trim().replace(/^@/, ''));
  }

  return tracked;
}

import fs from 'fs';

const BACKUP_KEEP_COUNT = 2;
const BACKUP_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // once a week

function getBackupFiles() {
  if (!fs.existsSync('./backups')) return [];
  return fs.readdirSync('./backups')
    .filter(name => name.startsWith('kick_tracker-') && name.endsWith('.db'))
    .map(name => {
      const fullPath = `./backups/${name}`;
      try {
        return { name, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
}

function pruneOldBackups() {
  const files = getBackupFiles();
  const extras = files.slice(BACKUP_KEEP_COUNT);
  for (const file of extras) {
    try {
      fs.unlinkSync(file.fullPath);
      console.log(`[DB] Pruned old backup: ${file.fullPath}`);
    } catch (error) {
      console.warn(`[DB] Could not prune backup ${file.fullPath}:`, error.message);
    }
  }
}

function createDatabaseBackup() {
  if (!fs.existsSync('./kick_tracker.db')) return null;

  fs.mkdirSync('./backups', { recursive: true });

  const existing = getBackupFiles();

  // Only back up once a week: skip if the newest backup is fresh.
  if (existing.length > 0 && (Date.now() - existing[0].mtimeMs) < BACKUP_MIN_INTERVAL_MS) {
    pruneOldBackups(); // still enforce the 2-file limit on every run
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `./backups/kick_tracker-${timestamp}.db`;
  fs.copyFileSync('./kick_tracker.db', backupPath);
  console.log(`[DB] Backup created: ${backupPath}`);

  pruneOldBackups(); // keep only the current + latest backup
  return backupPath;
}

async function refreshAllTrackedUsers() {
  const rows = await allQuery(`
    SELECT current_slug
    FROM channels
    WHERE current_slug IS NOT NULL AND current_slug != ''
    ORDER BY id ASC
  `);
  console.log(`[REFRESH-ALL] Refreshing ${rows.length} tracked users (profile data only, no chat)...`);

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    const tag = String(row.current_slug).toLowerCase().replace(/^@/, '').trim();
    if (!tag) continue;
    try {
      const payload = await fetchChannelByTag(tag);
      await processChannelPayload(payload);
      ok += 1;
    } catch (error) {
      failed += 1;
      console.warn(`[REFRESH-ALL] @${tag}: ${error.message}`);
    }
    // Small pause to stay friendly to the Kick API.
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  console.log(`[REFRESH-ALL] Done. Updated: ${ok}, failed: ${failed}.`);
}

async function main() {
  await initDb();

  if (process.argv[2] === '--backfill-snapshots') {
    console.log('[DB] Missing current follower snapshots backfilled without fetching targets.');
    db.close();
    return;
  }

  if (process.argv[2] === '--monitor') {
    await monitorTargets();
    return;
  }

  if (process.argv[2] === '--check-streamers') {
    await checkStreamerTagsOnce();
    db.close();
    return;
  }

  if (process.argv[2] === '--refresh-all') {
    await refreshAllTrackedUsers();
    db.close();
    return;
  }

  const refreshTarget = process.argv[2] === '--refresh' ? process.argv[3] : null;
  const targetsFile = fs.existsSync('./targets.txt') ? fs.readFileSync('./targets.txt', 'utf8') : '';
  const rawTargets = refreshTarget
    ? [refreshTarget]
    : targetsFile.split('\n').map(t => t.trim()).filter(t => t.length > 0);
  const trackedHandles = await getKnownTrackedHandles();

  const targets = [];
  const seenTargets = new Set();

  for (const target of rawTargets) {
    const normalized = target.toLowerCase().replace(/^@/, '').trim();
    if (!normalized) continue;
    if (!refreshTarget && trackedHandles.has(normalized)) {
      console.log(`[skip] Already tracked in database: ${target}`);
      continue;
    }
    if (seenTargets.has(normalized)) {
      continue;
    }

    seenTargets.add(normalized);
    targets.push(target);
  }

  if (targets.length === 0) {
    console.log("No targets found in targets.txt");
    db.close();
    return;
  }

  createDatabaseBackup();

  if (refreshTarget) {
    try {
      console.log(`Fetching target: ${refreshTarget}...`);
      const response = await fetch(`https://kick.com/api/v1/channels/${encodeURIComponent(refreshTarget)}`, {
        headers: { 'User-Agent': 'KickIntel Tracker/1.0' }
      });
      if (!response.ok) throw new Error(`Kick API returned ${response.status}`);
      const data = await response.json();
      if (!data || !data.id) throw new Error('Kick returned an invalid channel payload');
      await processChannelPayload(data);
      try {
        const chatResult = await collectAndLogChat(data, refreshTarget);
        if (chatResult.savedMessages || chatResult.discoveredUsers) {
          console.log(`[CHAT] Saved ${chatResult.savedMessages} messages and discovered ${chatResult.discoveredUsers} users for @${data.slug}`);
        }
      } catch (chatError) {
        console.warn(`[CHAT] Could not save live chat for @${data.slug}:`, chatError.message);
      }
      db.close();
      console.log('Target refresh finished successfully.');
      return;
    } catch (error) {
      db.close();
      console.error(`[X] Error refreshing target ${refreshTarget}:`, error.message);
      process.exitCode = 1;
      return;
    }
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  for (const target of targets) {
    try {
      console.log(`Fetching target: ${target}...`);
      await page.goto(`https://kick.com/api/v1/channels/${encodeURIComponent(target)}`, { waitUntil: 'networkidle2', timeout: 15000 });
      
      const content = await page.evaluate(() => document.body.innerText);
      const data = JSON.parse(content);

      if (data && data.id) {
        await processChannelPayload(data);
        try {
          const chatResult = await collectAndLogChat(data, target);
          if (chatResult.savedMessages || chatResult.discoveredUsers) {
            console.log(`[CHAT] Saved ${chatResult.savedMessages} messages and discovered ${chatResult.discoveredUsers} users for @${data.slug}`);
          }
        } catch (chatError) {
          console.warn(`[CHAT] Could not save live chat for @${data.slug}:`, chatError.message);
        }
      } else {
        console.log(`[-] Could not resolve payload for target: ${target}`);
      }
    } catch (err) {
      console.error(`[X] Error scraping target ${target}:`, err.message);
    }
  }

  await browser.close();
  db.close();
  console.log("Tracking iteration finished successfully.");
}

function getStreamerTags() {
  const streamersFile = fs.existsSync('./streamers.txt') ? fs.readFileSync('./streamers.txt', 'utf8') : '';
  const seen = new Set();
  return streamersFile.split('\n')
    .map(target => target.toLowerCase().replace(/^@/, '').trim())
    .filter(target => target && !target.startsWith('#') && !seen.has(target) && seen.add(target));
}

async function fetchChannelByTag(tag) {
  const response = await fetch(`https://kick.com/api/v1/channels/${encodeURIComponent(tag)}`, {
    headers: { 'User-Agent': 'KickIntel Tracker/1.0', Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Kick API returned ${response.status}`);
  const payload = await response.json();
  if (!payload?.id) throw new Error('Kick returned an invalid channel payload');
  return payload;
}

async function monitorTargets() {
  const intervalMs = Math.max(15000, Number(process.env.MONITOR_INTERVAL_MS || 30000));
  let stopping = false;

  const stop = () => {
    stopping = true;
    console.log('[MONITOR] Stop requested. Finishing the current check...');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log(`[MONITOR] Watching streamers.txt every ${Math.round(intervalMs / 1000)} seconds.`);
  console.log('[MONITOR] Live chat is collected only while Kick reports a streamer as live.');

  while (!stopping) {
    await checkStreamerTagsOnce(() => stopping);

    if (!stopping) {
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  db.close();
  console.log('[MONITOR] Stopped. Historical data was preserved.');
}

async function checkStreamerTagsOnce(shouldStop = () => false) {
  const tags = getStreamerTags();
  console.log(`[MONITOR] Checking ${tags.length} unique streamer tags...`);

  for (const tag of tags) {
    if (shouldStop()) break;
    try {
      const payload = await fetchChannelByTag(tag);
      await processChannelPayload(payload);
      const chatResult = await collectAndLogChat(payload, tag);
      if (chatResult.savedMessages || chatResult.discoveredUsers) {
        console.log(`[CHAT] @${payload.slug || tag}: saved ${chatResult.savedMessages} messages, discovered ${chatResult.discoveredUsers} users`);
      }
    } catch (error) {
      console.warn(`[MONITOR] @${tag}: ${error.message}`);
    }
  }
}

main();