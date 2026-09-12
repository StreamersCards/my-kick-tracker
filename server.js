import { createServer } from 'http';
import { readFile } from 'fs/promises';
import fs from 'fs';
import { spawn } from 'child_process';
import { resolve, extname, join } from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PORT = Number(process.env.PORT || 3000);
const refreshLimitPath = join(__dirname, '.refresh-rate-limit.json');
const refreshLimits = fs.existsSync(refreshLimitPath)
  ? JSON.parse(fs.readFileSync(refreshLimitPath, 'utf8'))
  : {};

const allowedPaths = new Set(['/','/index.html','/kick_tracker.db','/privacy.html','/terms.html']);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.db': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

async function serveFile(filePath, res) {
  try {
    const absolutePath = resolve(__dirname, filePath);
    const file = await readFile(absolutePath);
    const extension = extname(filePath).toLowerCase();
    setSecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': mimeTypes[extension] || 'application/octet-stream' });
    res.end(file);
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await getNotFoundPage());
  }
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

function sendJson(res, statusCode, payload) {
  setSecurityHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function getClientIp(req) {
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function getUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function saveRefreshLimits() {
  const temporaryPath = `${refreshLimitPath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(refreshLimits, null, 2));
  fs.renameSync(temporaryPath, refreshLimitPath);
}

function getChannelLastUpdated(handle) {
  return new Promise((resolveQuery, reject) => {
    const database = new sqlite3.Database(join(__dirname, 'kick_tracker.db'), sqlite3.OPEN_READONLY, (error) => {
      if (error) reject(error);
    });

    database.get(`
      SELECT c.last_updated, c.current_slug
      FROM channels c
      WHERE LOWER(c.current_slug) = ? OR LOWER(c.current_username) = ?
        OR EXISTS (
          SELECT 1 FROM username_history h
          WHERE h.channel_id = c.id
            AND (LOWER(h.slug) = ? OR LOWER(h.username) = ?)
        )
      LIMIT 1
    `, [handle, handle, handle, handle], (error, row) => {
      database.close();
      if (error) reject(error);
      else resolveQuery(row || null);
    });
  });
}

function runRefresh(handle) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(process.execPath, [join(__dirname, 'tracker.js'), '--refresh', handle], {
      cwd: __dirname,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let errorOutput = '';
    child.stderr.on('data', chunk => { errorOutput += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolveProcess();
      else reject(new Error(errorOutput.trim() || `Refresh exited with code ${code}`));
    });
  });
}

async function handleRefresh(req, res, requestUrl) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Refresh requires POST.' });
    return;
  }

  const handle = (requestUrl.searchParams.get('user') || '').trim().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9_-]{1,50}$/.test(handle)) {
    sendJson(res, 400, { error: 'Enter a valid Kick handle.' });
    return;
  }

  let channel;
  try {
    channel = await getChannelLastUpdated(handle);
  } catch (error) {
    sendJson(res, 500, { error: 'Could not inspect the database.' });
    return;
  }

  if (!channel) {
    sendJson(res, 404, { error: 'Search this handle first so it can be refreshed.' });
    return;
  }

  const updatedAt = channel.last_updated ? new Date(`${channel.last_updated.replace(' ', 'T')}Z`) : null;
  if (updatedAt && Number.isFinite(updatedAt.getTime()) && Date.now() - updatedAt.getTime() < 60 * 60 * 1000) {
    sendJson(res, 200, { ok: false, reason: 'fresh', message: 'This channel was fetched less than an hour ago.' });
    return;
  }

  const ip = getClientIp(req);
  const today = getUtcDate();
  if (refreshLimits[ip] === today) {
    sendJson(res, 429, { error: 'This IP has already used its refresh for today.' });
    return;
  }

  try {
    await runRefresh(channel.current_slug || handle);
    refreshLimits[ip] = today;
    saveRefreshLimits();
    sendJson(res, 200, { ok: true, message: 'Fresh data saved. Reloading the database snapshot.' });
  } catch (error) {
    sendJson(res, 502, { error: 'The Kick refresh failed.', detail: error.message });
  }
}

async function getNotFoundPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>404 - Page Not Found</title>
  <style>
    :root {
      --bg: #07090e;
      --card: rgba(15, 19, 28, 0.82);
      --border: rgba(255,255,255,0.08);
      --green: #53fc18;
      --text: #f0f4f8;
      --muted: #8a99ad;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: var(--bg);
      color: var(--text);
      font-family: Arial, Helvetica, sans-serif;
    }
    .card {
      width: min(90vw, 560px);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 42px 28px;
      text-align: center;
      box-shadow: 0 30px 60px rgba(0,0,0,0.5);
    }
    .code {
      font-size: clamp(3rem, 8vw, 6rem);
      font-weight: 800;
      color: var(--green);
      letter-spacing: 0.08em;
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(1.5rem, 3vw, 2.3rem);
    }
    p {
      margin: 0 0 24px;
      color: var(--muted);
      line-height: 1.6;
    }
    a {
      display: inline-block;
      background: var(--green);
      color: #000;
      text-decoration: none;
      font-weight: 700;
      padding: 12px 20px;
      border-radius: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="code">404</div>
    <h1>Page Not Found</h1>
    <p>The page you requested does not exist or is not available on this site.</p>
    <a href="/">Return Home</a>
  </div>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(requestUrl.pathname);

    if (pathname === '/api/refresh') {
      await handleRefresh(req, res, requestUrl);
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      await serveFile('index.html', res);
      return;
    }

    if (pathname === '/kick_tracker.db') {
      await serveFile('kick_tracker.db', res);
      return;
    }

    if (pathname === '/privacy.html' || pathname === '/terms.html') {
      await serveFile(pathname.slice(1), res);
      return;
    }

    if (pathname === '/404' || pathname === '/404.html') {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await getNotFoundPage());
      return;
    }

    if (pathname.includes('..')) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await getNotFoundPage());
      return;
    }

    if (allowedPaths.has(pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await getNotFoundPage());
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await getNotFoundPage());
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await getNotFoundPage());
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
