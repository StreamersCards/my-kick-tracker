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
  return new Promise((resolve) => {
    db.serialize(() => {
      // 1. Core channels table
      db.run(`
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

      // Migration for column upgrades if table already exists
      const columns = [
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

      columns.forEach(col => {
        db.run(`ALTER TABLE channels ADD COLUMN ${col.name} ${col.type}`, () => {});
      });

      // 2. Historical Username Tracker Table
      db.run(`
        CREATE TABLE IF NOT EXISTS username_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id INTEGER,
          slug TEXT,
          username TEXT,
          detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(channel_id) REFERENCES channels(id)
        )
      `);

      // 3. Historical Socials Tracker Table
      db.run(`
        CREATE TABLE IF NOT EXISTS socials_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_id INTEGER,
          field_name TEXT,
          old_value TEXT,
          new_value TEXT,
          detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(channel_id) REFERENCES channels(id)
        )
      `, () => {
        resolve();
      });
    });
  });
}

async function processChannelPayload(data) {
  if (!data || !data.id) return null;

  const channelId = data.id;
  const userObj = data.user || {};
  const userId = data.user_id || userObj.id || null;
  const newSlug = data.slug;
  const newUsername = userObj.username || newSlug;
  const followersCount = parseInt(data.followers_count || 0, 10);
  const isBanned = data.is_banned ? 1 : 0;
  const verified = data.verified ? 1 : 0;
  
  // Subscription / Monetized status check
  const subscriptionEnabled = (data.subscription_enabled || data.is_affiliate) ? 1 : 0;
  
  // Extract vod_enabled from data object or fallback check
  const vodEnabled = (data.vod_enabled === true || (data.vod_enabled !== false && data.vod_enabled !== 0)) ? 1 : 0;

  const livestreamTitle = data.livestream ? data.livestream.session_title : null;
  const rawPayload = JSON.stringify(data);

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

  return channelId;
}

import fs from 'fs';

async function main() {
  await initDb();

  const targetsFile = fs.existsSync('./targets.txt') ? fs.readFileSync('./targets.txt', 'utf8') : '';
  const targets = targetsFile.split('\n').map(t => t.trim()).filter(t => t.length > 0);

  if (targets.length === 0) {
    console.log("No targets found in targets.txt");
    db.close();
    return;
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

main();