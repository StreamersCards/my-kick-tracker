const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'kick_tracker.db');

// Helper to wrap SQLite operations in Promises
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

function allQuery(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Initialize tables
async function initDb(db) {
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
      raw_payload TEXT,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
}

// Process single Kick payload
async function processChannelPayload(db, data) {
  if (!data || !data.id) return;

  const channelId = data.id;
  const userId = data.user_id || (data.user ? data.user.id : null);
  const newSlug = data.slug;
  const newUsername = (data.user && data.user.username) ? data.user.username : newSlug;
  const followersCount = parseInt(data.followers_count || 0, 10);
  const isBanned = data.is_banned ? 1 : 0;
  const verified = data.verified ? 1 : 0;
  const livestreamTitle = data.livestream ? data.livestream.session_title : null;
  const rawPayload = JSON.stringify(data);

  // Check if channel exists by immutable ID
  const existing = await getQuery(db, 'SELECT current_slug, current_username FROM channels WHERE id = ?', [channelId]);

  if (!existing) {
    // Brand new entry
    await runQuery(db, `
      INSERT INTO channels (
        id, user_id, current_slug, current_username, followers_count,
        is_banned, verified, livestream_title, raw_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [channelId, userId, newSlug, newUsername, followersCount, isBanned, verified, livestreamTitle, rawPayload]);

    await runQuery(db, `
      INSERT INTO username_history (channel_id, slug, username)
      VALUES (?, ?, ?)
    `, [channelId, newSlug, newUsername]);

    console.log(`[+] Initialized record: ${newUsername} (ID: ${channelId})`);
  } else {
    // Update existing record
    await runQuery(db, `
      UPDATE channels
      SET current_slug = ?,
          current_username = ?,
          followers_count = ?,
          is_banned = ?,
          verified = ?,
          livestream_title = ?,
          raw_payload = ?,
          last_updated = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [newSlug, newUsername, followersCount, isBanned, verified, livestreamTitle, rawPayload, channelId]);

    // Track username change if changed
    if (existing.current_slug.toLowerCase() !== newSlug.toLowerCase()) {
      console.log(`[!] HANDLE CHANGE DETECTED: @${existing.current_slug} -> @${newSlug}`);
      await runQuery(db, `
        INSERT INTO username_history (channel_id, slug, username)
        VALUES (?, ?, ?)
      `, [channelId, newSlug, newUsername]);
    } else {
      console.log(`[=] Updated data for @${newSlug}`);
    }
  }
}

// Search utility (CLI / verification)
async function searchUser(db, handle) {
  const query = `
    SELECT c.id, c.current_username, c.current_slug, c.followers_count, h.slug, h.detected_at
    FROM username_history h
    JOIN channels c ON h.channel_id = c.id
    WHERE LOWER(h.slug) = LOWER(?) OR LOWER(h.username) = LOWER(?)
    ORDER BY h.detected_at ASC
  `;
  const rows = await allQuery(db, query, [handle, handle]);

  if (!rows || rows.length === 0) {
    console.log(`\n[-] No history found for handle: '${handle}'`);
    return;
  }

  console.log("\n==================================================");
  console.log(`CHANNEL FOUND (ID: ${rows[0].id})`);
  console.log(`Current Handle : ${rows[0].current_username} (@${rows[0].current_slug})`);
  console.log(`Followers      : ${rows[0].followers_count.toLocaleString()}`);
  console.log("--------------------------------------------------");
  console.log("HANDLE HISTORY TIMELINE:");
  rows.forEach(r => console.log(`  • [${r.detected_at}] @${r.slug}`));
  console.log("==================================================\n");
}

(async () => {
  const db = await openDatabase();
  await initDb(db);

  // Read targets from file
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

  console.log("Launching Puppeteer browser...");
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu'
    ]
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  for (const slug of targets) {
    console.log(`\nFetching API data for channel: ${slug}...`);
    try {
      await page.goto(`https://kick.com/api/v2/channels/${slug}`, {
        waitUntil: 'networkidle2',
        timeout: 20000
      });

      const content = await page.evaluate(() => document.body.innerText);
      const jsonData = JSON.parse(content);

      await processChannelPayload(db, jsonData);

    } catch (error) {
      console.error(`[-] Error fetching channel ${slug}:`, error.message);
    }

    // Delay between calls to remain undetected
    await new Promise(r => setTimeout(r, 2000));
  }

  await browser.close();

  // Test lookup after process finishes
  if (targets.length > 0) {
    await searchUser(db, targets[0]);
  }

  db.close();
  console.log("Job completed successfully.");
})();