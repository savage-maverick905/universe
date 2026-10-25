# Jupiter: your own music, in your own pocket

Personal music library and player inside Universe (`apps/jupiter`). Music you upload, stored in your private GitHub repo, played from your own server code. No external catalogue.

## What it does
Upload (phone or desktop) MP3, M4A/AAC, FLAC, OGG, WAV; edit title, artists (several), album, album artist, track/disc, year/date, genre, custom tags, description; cover art for tracks, albums and artists; likes, playlists (add, remove, reorder), queue, shuffle, repeat, seek, volume, mini-player, Now Playing, keyboard keys (Space, arrows, Shift+arrows, M), Media Session lock-screen controls; selective offline downloads; listening stats; Nebula control.

## How it fits Universe
Discovered through `manifest.json` like every app. Auth, roles and permissions are Universe's. Metadata lives in the normal database (collections `jupiter_tracks`, `jupiter_playlists`, `jupiter_albums`, `jupiter_artists`, `jupiter_settings`). Nothing else in Universe was replaced. Small additive core changes: binary (`raw`) routes and handled responses in `http/`, `clientContext` in and `actions` out of `/api/ai/chat` (tools may ask the browser to act; the model never sees them), `blob:` allowed for media/images in the CSP, `jupiter` block in `config/env.js`, a `crons` entry in `vercel.json`, a few icons.

## Permissions
`jupiter.library.read|write|delete`, `jupiter.stats.read`, `jupiter.admin.maintain`. Granted to **admin only** on install. `resident` gets nothing by default on purpose: public sign-up gives new accounts the resident role, and uploads cost your GitHub storage. Grant per user or role via the Universe API when you want to.

## Storage layout
- **Universe data branch** (`GITHUB_BRANCH`, default `universe-data`): metadata JSON only. Never used for audio. The media store refuses to run on that branch, `main` or `master`.
- **Music branch** (`JUPITER_MEDIA_BRANCH`, default `jupiter-media`, created automatically as an *orphan* branch, optionally in a separate repo via `JUPITER_MEDIA_REPO`):
  - `tracks/<trackId>/0000.part, 0001.part, …` audio in 3 MiB parts (so no Git file is near the 100 MiB limit and every response fits Vercel's 4.5 MB limit)
  - `art/art_<id>.<jpg|png|webp>` artwork
  - `analytics/YYYY-MM/<user>.jsonl` raw listening events (one file per month)
- Local development without GitHub (`STORAGE_DRIVER=sqlite`): same layout as files under `JUPITER_MEDIA_DIR`.

## Upload path (Vercel-safe)
`start` (size, quota, duplicate check by content fingerprint) → one `PUT` per 3 MiB piece (server hashes it, checks audio magic bytes on piece 0, stores a Git blob, returns an HMAC-signed ticket) → optional cover → `finish` (tickets verified, ONE Git commit, then the database record; if the record fails the files are removed). A failed upload leaves no half-saved track. Extensions, MIME types and filenames are never trusted.

## Playback
`GET /api/apps/jupiter/tracks/:id/audio` needs the session cookie, answers `Range` requests with one stored part per response (`Cache-Control: private`). Seeking works. Nothing is downloaded up front.

## Offline
Per track, user-chosen (⋯ → Download for offline). Saved piece by piece in IndexedDB, marked available only when the byte count matches. Downloads page shows progress, usage, and removal; offline mode lists only downloaded tracks. Limits: browsers can evict this storage under pressure; iOS Safari may clear it for sites not on the Home Screen; storage quota varies by device. This is not a backup. Background playback with the screen locked depends on the OS/browser and is not guaranteed.

## Analytics
One event per listen (≥3 s kept, <3 s dropped). A **play** needs 30 s (or half of a track under a minute); less is a **skip**; reaching 80%+ with the track ending is a **complete**. Ids are deduplicated server-side. Raw events go to the monthly files above, not the database; the database keeps only per-track counters. Days before tracking began are shown as **no data**, not zero.

## Nebula
Tools: `jupiter.libraryOverview`, `searchLibrary`, `listeningStats`, `nowPlaying`, `play`, `control`, `createPlaylist`, `addToPlaylist`, `requestDelete`. Every id is checked against the real library; "not found" is reported, never invented. Delete/clear actions only show a confirmation card in the app. The player runs in your browser, so Nebula's play/control commands are executed by the open Jupiter page (Jupiter's Nebula panel). Browsers may block autoplay started from an async reply on some phones; tap play then.

## Environment variables (see `.env.example`)
`JUPITER_MEDIA_REPO`, `JUPITER_MEDIA_BRANCH`, `JUPITER_MEDIA_TOKEN`, `JUPITER_MEDIA_DRIVER`, `JUPITER_MEDIA_DIR`, `JUPITER_SECRET` (default `KEY_ENCRYPTION_SECRET`, 16+ chars), `JUPITER_MAX_FILE_MB` (200), `JUPITER_LIBRARY_LIMIT_MB` (900), `CRON_SECRET`.

## Deploy
1. Deploy as in the main README (section 11d). The existing token (Contents: read/write) is enough.
2. Add `CRON_SECRET` (random string) in Vercel. Optionally the other variables above.
3. Sign in as admin → Apps → install Jupiter → open `/apps/jupiter/` and add the app to your Home Screen.

## Weekly history cleanup
`vercel.json` has a cron (`0 3 * * 0`, Sundays 03:00 UTC) calling `/api/apps/jupiter/maintenance/weekly` with `Authorization: Bearer $CRON_SECRET` (Vercel sends it). It squashes the **music branch only** to one commit pointing at the identical tree (verified before and after), skips if a track was added in the last 15 minutes or the branch moved meanwhile, and never touches the data branch. Admins can also run it from More → Storage upkeep. A weekly Vercel cron should be allowed on the free Hobby plan (limit: once per day) but this was **not verified on a real deployment**. If it does not run, use the manual button. GitHub may keep old commits reachable by hash until it garbage-collects; this limits growth, it does not guarantee erasure.

## Not done / not verified
No real GitHub or Vercel run (tested against an in-memory GitHub fake). No browser run: the UI, IndexedDB offline code, Media Session and Nebula panel are syntax-checked and their pure logic tested, but never exercised in a real browser. Optional full-library backup is not built (only a metadata-only JSON export). Library list loads in one request (fine to a few thousand tracks). Orphan files are reported, not auto-deleted. Gapless playback not implemented. Reports integration and the admin "grant to user" screen are not built.
