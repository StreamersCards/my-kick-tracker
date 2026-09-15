# my-kick-tracker

Tracks public Kick channel profiles, username changes, social links, follower counts, and public
chat messages into `kick_tracker.db`, then publishes that database as the static data file the site
(`index.html`, `users.html`) loads in the browser with sql.js.

## How it runs

* `.github/workflows/chat-collector.yml` (the "auto cycle"): one long-lived worker per run. It polls
  `streamers.txt` every minute, pushes `kick_tracker.db` + `logz.txt` every 15 minutes, refreshes
  every tracked profile about every 2 hours, and stops itself around 5.5h so the next queued run
  takes over. Only one worker writes the database at a time (concurrency group `kick-db-writer`).
* `.github/workflows/full-refresh.yml`: manual escape hatch that refreshes every tracked channel.

## Scripts

| script | what it does |
| --- | --- |
| `npm run check-streamers` | one poll of `streamers.txt` (profiles + live chat) |
| `npm run refresh-all` | refresh profile data for every tracked channel |
| `npm run prune` | compact `kick_tracker.db` (see below) |
| `npm run monitor` | local continuous polling loop |
| `npm run serve` | serve the site and the database locally on port 3000 |

## Database maintenance (why `npm run prune` exists)

`kick_tracker.db` is committed on every push, and **GitHub rejects any push that contains a file
larger than 100 MiB**. On 2026-09-15 the file crossed that limit, so every auto-cycle push was
rejected by GitHub while the worker kept collecting (the job still reported success), and the site
silently stopped updating.

`npm run prune` keeps the file far below the limit. It:

1. slims legacy chat payloads - Kick's reply `metadata` re-serialised the entire quoted message and
   the tracker stored it twice, which was ~75 MB of the database,
2. deletes chat messages past the retention window,
3. enforces a hard size cap, deleting the oldest messages first, then VACUUMs.

The chat worker does the same maintenance after every poll and right before every push, and both
workflows refuse to push a database that is still at or above 100 MiB.

| env var | default | meaning |
| --- | --- | --- |
| `CHAT_RETENTION_DAYS` | `7` | how long saved chat messages are kept |
| `CHAT_MAX_DB_MB` | `70` | hard size cap for `kick_tracker.db` |
| `CHAT_LOG_MAX_BYTES` | `5242880` | rotate `logz.txt` once it grows past this |
| `CHAT_LOG_KEEP_LINES` | `20000` | lines kept when `logz.txt` rotates |

Channel profiles, username history, social history, and follower snapshots are kept indefinitely;
only chat messages are pruned.