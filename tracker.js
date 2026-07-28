const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'kick_tracker.db');
const TARGETS_FILE = path.join(__dirname, 'targets.txt');

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      current_slug TEXT NOT NULL,
      current_username TEXT NOT NULL,
      followers_count INTEGER,
      is_banned INTEGER,
      verified INTEGER,
      subscription_enabled INTEGER DEFAULT 0,
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

  // Ensure missing columns exist on existing databases
  const columns = [
    { name: 'bio', type: 'TEXT' },
    { name: 'instagram', type: 'TEXT' },
    { name: 'twitter', type: 'TEXT' },
    { name: 'youtube', type: 'TEXT' },
    { name: 'discord', type: 'TEXT' },
    { name: 'tiktok', type: 'TEXT' },
    { name: 'facebook', type: 'TEXT' },
    { name: 'profile_pic', type: 'TEXT' },
    { name: 'subscription_enabled', type: 'INTEGER DEFAULT 0' }
  ];

  columns.forEach(col => {
    db.run(`ALTER TABLE channels ADD COLUMN ${col.name} ${col.type}`, () => {});
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS username_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      slug TEXT NOT NULL,
      username TEXT NOT NULL,
      detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES channels (id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS socials_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      field_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES channels (id)
    )
  `);
});

function runQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function processChannelPayload(data) {
  if (!data || !data.id) return;

  const channelId = data.id;
  const userObj = data.user || {};
  const userId = data.user_id || userObj.id || null;
  const newSlug = data.slug;
  const newUsername = userObj.username || newSlug;
  const followersCount = parseInt(data.followers_count || 0, 10);
  const isBanned = data.is_banned ? 1 : 0;
  const verified = data.verified ? 1 : 0;
  const subscriptionEnabled = (data.subscription_enabled || data.is_affiliate) ? 1 : 0;
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
        is_banned, verified, subscription_enabled, livestream_title, bio, instagram, twitter,
        youtube, discord, tiktok, facebook, profile_pic, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      channelId, userId, newSlug, newUsername, followersCount,
      isBanned, verified, subscriptionEnabled, livestreamTitle, bio, instagram, twitter,
      youtube, discord, tiktok, facebook, profilePic, rawPayload
    ]);

    await runQuery(`
      INSERT INTO username_history (channel_id, slug, username)
      VALUES (?, ?, ?)
    `, [channelId, newSlug, newUsername]);

    console.log(`[+] Tracked new channel: @${newSlug}`);
  } else {
    await runQuery(`
      UPDATE channels
      SET current_slug = ?, current_username = ?, followers_count = ?,
          is_banned = ?, verified = ?, subscription_enabled = ?, livestream_title = ?, bio = ?,
          instagram = ?, twitter = ?, youtube = ?, discord = ?,
          tiktok = ?, facebook = ?, profile_pic = ?, raw_payload = ?,
          last_updated = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      newSlug, newUsername, followersCount, isBanned, verified, subscriptionEnabled,
      livestreamTitle, bio, instagram, twitter, youtube, discord,
      tiktok, facebook, profilePic, rawPayload, channelId
    ]);

    if (existing.current_slug.toLowerCase() !== newSlug.toLowerCase()) {
      await runQuery(`
        INSERT INTO username_history (channel_id, slug, username)
        VALUES (?, ?, ?)
      `, [channelId, newSlug, newUsername]);
    }

    const socialFields = [
      { name: 'bio', oldVal: existing.bio, newVal: bio },
      { name: 'instagram', oldVal: existing.instagram, newVal: instagram },
      { name: 'twitter', oldVal: existing.twitter, newVal: twitter },
      { name: 'youtube', oldVal: existing.youtube, newVal: youtube },
      { name: 'discord', oldVal: existing.discord, newVal: discord },
      { name: 'tiktok', oldVal: existing.tiktok, newVal: tiktok },
      { name: 'facebook', oldVal: existing.facebook, newVal: facebook }
    ];

    for (const item of socialFields) {
      if ((item.oldVal || "") !== (item.newVal || "")) {
        await runQuery(`
          INSERT INTO socials_history (channel_id, field_name, old_value, new_value)
          VALUES (?, ?, ?, ?)
        `, [channelId, item.name, item.oldVal, item.newVal]);
      }
    }
  }
}

async function run() {
  if (!fs.existsSync(TARGETS_FILE)) {
    console.error('[-] targets.txt missing');
    process.exit(1);
  }

  const targets = fs.readFileSync(TARGETS_FILE, 'utf-8')
    .split('\n')
    .map(t => t.trim())
    .filter(t => t && !t.startsWith('#'));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  for (const slug of targets) {
    try {
      await page.goto(`https://kick.com/api/v2/channels/${slug}`, { waitUntil: 'networkidle2', timeout: 20000 });
      const content = await page.evaluate(() => document.body.innerText);
      await processChannelPayload(JSON.parse(content));
    } catch (err) {
      console.error(`[-] Error scraping ${slug}:`, err.message);
    }
  }

  await browser.close();
  db.close();
}

run();