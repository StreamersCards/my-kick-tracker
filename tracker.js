const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'kick_tracker.db');

function openDatabase() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}

function runQuery(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getQuery(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function initDb(db) {
  // Main Channel Table
  await runQuery(db, `
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      current_slug TEXT NOT NULL,
      current_username TEXT NOT NULL,
      followers_count INTEGER,
      is_banned INTEGER,
      verified INTEGER,
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

  // Username History Table
  await runQuery(db, `
    CREATE TABLE IF NOT EXISTS username_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      slug TEXT NOT NULL,
      username TEXT NOT NULL,
      detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES channels (id)
    )
  `);

  // Social Links & Bio History Table
  await runQuery(db, `
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
}

async function processChannelPayload(db, data) {
  if (!data || !data.id) return;

  const channelId = data.id;
  const userObj = data.user || {};
  const userId = data.user_id || userObj.id || null;
  const newSlug = data.slug;
  const newUsername = userObj.username || newSlug;
  const followersCount = parseInt(data.followers_count || 0, 10);
  const isBanned = data.is_banned ? 1 : 0;
  const verified = data.verified ? 1 : 0;
  const livestreamTitle = data.livestream ? data.livestream.session_title : null;
  const rawPayload = JSON.stringify(data);

  // Social media fields
  const bio = userObj.bio || "";
  const instagram = userObj.instagram || "";
  const twitter = userObj.twitter || "";
  const youtube = userObj.youtube || "";
  const discord = userObj.discord || "";
  const tiktok = userObj.tiktok || "";
  const facebook = userObj.facebook || "";
  const profilePic = userObj.profile_pic || "";

  const existing = await getQuery(
    db, 
    'SELECT * FROM channels WHERE id = ?', 
    [channelId]
  );

  if (!existing) {
    // 1. Initial Insert for New Channel
    await runQuery(db, `
      INSERT INTO channels (
        id, user_id, current_slug, current_username, followers_count,
        is_banned, verified, livestream_title, bio, instagram, twitter,
        youtube, discord, tiktok, facebook, profile_pic, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      channelId, userId, newSlug, newUsername, followersCount,
      isBanned, verified, livestreamTitle, bio, instagram, twitter,
      youtube, discord, tiktok, facebook, profilePic, rawPayload
    ]);

    // Record initial handle in history
    await runQuery(db, `
      INSERT INTO username_history (channel_id, slug, username)
      VALUES (?, ?, ?)
    `, [channelId, newSlug, newUsername]);

    console.log(`[+] Initialized record for @${newSlug}`);

  } else {
    // 2. Update existing channel details
    await runQuery(db, `
      UPDATE channels
      SET current_slug = ?,
          current_username = ?,
          followers_count = ?,
          is_banned = ?,
          verified = ?,
          livestream_title = ?,
          bio = ?,
          instagram = ?,
          twitter = ?,
          youtube = ?,
          discord = ?,
          tiktok = ?,
          facebook = ?,
          profile_pic = ?,
          raw_payload = ?,
          last_updated = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      newSlug, newUsername, followersCount, isBanned, verified,
      livestreamTitle, bio, instagram, twitter, youtube, discord,
      tiktok, facebook, profilePic, rawPayload, channelId
    ]);

    // 3. Track Handle Changes
    if (existing.current_slug.toLowerCase() !== newSlug.toLowerCase()) {
      console.log(`[!] HANDLE CHANGE: @${existing.current_slug} -> @${newSlug}`);
      await runQuery(db, `
        INSERT INTO username_history (channel_id, slug, username)
        VALUES (?, ?, ?)
      `, [channelId, newSlug, newUsername]);
    }

    // 4. Track Social Link & Bio Changes
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
        console.log(`[!] SOCIAL CHANGE (@${newSlug}): ${item.name} changed from "${item.oldVal}" to "${item.newVal}"`);
        await runQuery(db, `
          INSERT INTO socials_history (channel_id, field_name, old_value, new_value)
          VALUES (?, ?, ?, ?)
        `, [channelId, item.name, item.oldVal, item.newVal]);
      }
    }
  }
}

(async () => {
  const db = await openDatabase();
  await initDb(db);

  let targets = [];
  if (fs.existsSync('targets.txt')) {
    targets = fs.readFileSync('targets.txt', 'utf-8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  }

  if (targets.length === 0) {
    console.log("No targets found in targets.txt");
    db.close();
    return;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  for (const slug of targets) {
    try {
      await page.goto(`https://kick.com/api/v2/channels/${slug}`, {
        waitUntil: 'networkidle2',
        timeout: 20000
      });

      const content = await page.evaluate(() => document.body.innerText);
      const jsonData = JSON.parse(content);

      await processChannelPayload(db, jsonData);
    } catch (error) {
      console.error(`[-] Error fetching ${slug}:`, error.message);
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();
  db.close();
})();