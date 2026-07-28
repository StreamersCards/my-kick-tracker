const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'kick_tracker.db');
const TARGETS_FILE = path.join(__dirname, 'targets.txt');

// Initialize SQLite database
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  // Main channels table
  db.run(`
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      display_name TEXT,
      bio TEXT,
      avatar TEXT,
      banner TEXT,
      verified INTEGER,
      followers INTEGER,
      instagram TEXT,
      youtube TEXT,
      twitter TEXT,
      tiktok TEXT,
      discord TEXT,
      created_at TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // History table to track username/handle changes
  db.run(`
    CREATE TABLE IF NOT EXISTS handle_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER,
      old_username TEXT,
      new_username TEXT,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(channel_id) REFERENCES channels(id)
    )
  `);

  // History table to track social link changes
  db.run(`
    CREATE TABLE IF NOT EXISTS social_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER,
      platform TEXT,
      old_value TEXT,
      new_value TEXT,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(channel_id) REFERENCES channels(id)
    )
  `);
});

async function scrapeKickChannel(username, browser) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    const targetUrl = `https://kick.com/api/v2/channels/${username}`;
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    const content = await page.evaluate(() => document.body.innerText);
    const data = JSON.parse(content);

    if (!data || !data.user) {
      console.log(`[!] Channel ${username} not found or invalid API response.`);
      await page.close();
      return;
    }

    const userData = {
      username: data.user.username.toLowerCase(),
      display_name: data.user.username,
      bio: data.user.bio || '',
      avatar: data.user.profile_pic || '',
      banner: data.user.banner_image ? data.user.banner_image.url : '',
      verified: data.user.verified ? 1 : 0,
      followers: data.followers_count || 0,
      instagram: data.user.instagram || '',
      youtube: data.user.youtube || '',
      twitter: data.user.twitter || '',
      tiktok: data.user.tiktok || '',
      discord: data.user.discord || ''
    };

    saveChannelData(userData);
  } catch (err) {
    console.error(`[-] Error scraping ${username}:`, err.message);
  } finally {
    await page.close();
  }
}

function saveChannelData(data) {
  db.get('SELECT * FROM channels WHERE username = ?', [data.username], (err, row) => {
    if (err) {
      console.error('[-] DB Select Error:', err);
      return;
    }

    if (!row) {
      // Insert new record
      const stmt = db.prepare(`
        INSERT INTO channels (
          username, display_name, bio, avatar, banner, verified, followers,
          instagram, youtube, twitter, tiktok, discord, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);
      stmt.run(
        data.username, data.display_name, data.bio, data.avatar, data.banner,
        data.verified, data.followers, data.instagram, data.youtube,
        data.twitter, data.tiktok, data.discord
      );
      stmt.finalize();
      console.log(`[+] Added new channel: ${data.username}`);
    } else {
      // Check for social updates and log history
      const platforms = ['instagram', 'youtube', 'twitter', 'tiktok', 'discord'];
      platforms.forEach((platform) => {
        if (row[platform] !== data[platform] && data[platform] !== '') {
          db.run(
            `INSERT INTO social_history (channel_id, platform, old_value, new_value) VALUES (?, ?, ?, ?)`,
            [row.id, platform, row[platform] || 'NONE', data[platform]]
          );
        }
      });

      // Update existing record
      const stmt = db.prepare(`
        UPDATE channels SET
          display_name = ?, bio = ?, avatar = ?, banner = ?, verified = ?,
          followers = ?, instagram = ?, youtube = ?, twitter = ?, tiktok = ?,
          discord = ?, last_updated = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      stmt.run(
        data.display_name, data.bio, data.avatar, data.banner, data.verified,
        data.followers, data.instagram, data.youtube, data.twitter,
        data.tiktok, data.discord, row.id
      );
      stmt.finalize();
      console.log(`[*] Updated channel: ${data.username}`);
    }
  });
}

async function run() {
  if (!fs.existsSync(TARGETS_FILE)) {
    console.error('[-] targets.txt file not found!');
    process.exit(1);
  }

  const targets = fs.readFileSync(TARGETS_FILE, 'utf-8')
    .split('\n')
    .map(t => t.trim())
    .filter(t => t.length > 0);

  console.log(`[*] Loaded ${targets.length} target(s)...`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ]
  });

  for (const target of targets) {
    console.log(`[*] Scraping: ${target}`);
    await scrapeKickChannel(target, browser);
  }

  await browser.close();
  console.log('[*] Scraping finished.');
}

run();