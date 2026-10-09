# Universe

A modular, multi-user ecosystem of small applications with a central dashboard and a personal AI assistant for every user. One repository, one server, no npm dependencies.

Status labels used below: **Implemented** (built and covered by automated tests), **Unverified** (built, but not tested against the real external service or in a browser), **Not built** (planned).

## 1. What it is, and what exists today

**Purpose:** a private "home operating system" for your data. Apps (modules) plug into a shared dashboard, shared accounts and permissions, a shared AI assistant and a shared report engine. Later it should run on your own home server.

| Part | State |
|---|---|
| Accounts, sessions, roles (admin, resident, guest), granular permissions, audit log | Implemented (API). **No admin screen yet**: manage users and roles through the API (section 9) |
| Dashboard: sign-in, Home with widgets, Apps (install/enable/disable/uninstall), Assistant, Reports | Implemented, but never exercised in a real browser by the automated tests: expect UI rough edges |
| Inventory app (items, categories, locations, history, relationships, search/filter/sort, photos, JSON export/import) | Implemented (API); screens as above. Photo upload: Unverified (needs your Cloudinary account) |
| Personal AI (name, personality, stored conversations, read-only tools, shared or own API key) | Implemented against a fake provider and a mock Groq server. **Unverified against real Groq**: see `docs/AI_ARCHITECTURE.md`, "First real run" |
| Reports (daily, weekly, monthly, yearly, last N days, custom range; per app or ecosystem-wide; saved reports) | Implemented. Inventory is the first source |
| Data export/import for moving to a home server | Implemented and tested with a real database round trip |
| Deployment to a cloud host or a home server | Unverified (instructions below are untested) |
| Smart-home integrations, local AI model, local image storage, item sharing between users, AI write actions, scheduled reports | Not built |

## 2. Architecture in one picture

```
Browser (HTML/CSS/vanilla JS)  --JSON/HTTPS-->  API (Node http, routes, auth, validation)
                                                      |
              services: auth, permissions, apps, AI orchestrator, reports, audit
                                                      |
                     storage interface  -->  SQLite driver (today)  |  other drivers (future)
   third parties behind small interfaces:  AIProvider (Groq),  MediaUploader (Cloudinary)
```
Details: `docs/ARCHITECTURE.md` (system), `docs/DATA_MODEL.md` (data), `docs/AI_ARCHITECTURE.md` (AI), `docs/ADDING_A_NEW_APPLICATION.txt` (building apps).

## 3. Project structure

```
api/          HTTP server, router, middleware, static serving, core routes (api/routes/)
auth/         passwords, sessions, users, roles/permissions, profile visibility, audit log
ai/           orchestrator, provider interface + Groq (ai/providers/), tool registry, core tools
core/         app registry, installer, app loader, report engine, manifest schema
database/     storage interface, SQLite driver (database/drivers/), migrations/ (empty)
dashboard/    the dashboard UI (index.html, app.js, assistant.js, reports.js, styles.css)
apps/         one folder per application (only inventory/ today)
shared/       design tokens (theme.css), validators, errors, ids
config/       environment loading
scripts/      export-data.js, import-data.js
docs/         documentation and the Tasks example app (docs/examples/tasks)
tests/        automated tests (node:test)
```

## 4. Quick start from a fresh clone

You need **Node.js 22.5 or newer** (`node -v`). There is nothing to `npm install`.

1. `cp .env.example .env`
2. Edit `.env` and set the first admin (used only when the database is empty):
   ```
   BOOTSTRAP_ADMIN_EMAIL=you@example.com
   BOOTSTRAP_ADMIN_PASSWORD=a-long-password-of-10-or-more-characters
   ```
3. `npm start`, then open http://127.0.0.1:3000 and sign in.
4. **Remove `BOOTSTRAP_ADMIN_PASSWORD` from `.env`** and restart (it is not needed again).
5. Optional: add the AI and photo settings (sections 7 and 8).
6. `npm test` runs the automated tests (Node prints an `ExperimentalWarning` about `node:sqlite`; that is expected).

Use it: Apps > Install on Inventory > Open. Home then shows its widgets. `npm run dev` restarts the server when files change.

## 5. Configuration (environment variables)

| Variable | Meaning | Default |
|---|---|---|
| `NODE_ENV` | `production` turns on Secure cookies and HSTS (needs HTTPS) | development |
| `STORAGE_DRIVER` | `sqlite` or `github` (see section 11b) | sqlite |
| `GITHUB_TOKEN`, `GITHUB_REPO` | github driver only: fine-grained token (Contents read/write) and `owner/name` of a **private** repo | empty |
| `GITHUB_BRANCH`, `GITHUB_DATA_PATH`, `GITHUB_FLUSH_MS` | github driver only: branch (created if missing), file path, and the longest wait before saving | `universe-data`, `universe-data.json`, 3000 |
| `SIGNUP_ENABLED`, `SIGNUP_ROLE`, `SIGNUP_ALLOW_AI` | Public sign-up defaults (admins can change them in Settings): on or off, role for new accounts, whether they may use the shared AI key | true, resident, false |
| `GITHUB_EPHEMERAL_COLLECTIONS` | github driver only: comma list of collections kept in memory and never committed (for example `sessions`) | empty |
| `HOST` | interface to listen on; `0.0.0.0` only behind a proxy/firewall | `127.0.0.1` |
| `PORT` | port | `3000` |
| `TRUST_PROXY` | `true` only if exactly one reverse proxy sits in front (client IP from `X-Forwarded-For`) | `false` |
| `ALLOWED_ORIGINS` | extra origins allowed to call the API (normally empty) | empty |
| `STORAGE_DRIVER` | storage driver (`sqlite`) | `sqlite` |
| `SQLITE_PATH` | database file | `./data/universe.db` |
| `SESSION_TTL_HOURS` | session lifetime | `168` |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | first admin, only when no users exist | empty |
| `KEY_ENCRYPTION_SECRET` | 64 hex characters; encrypts users' own AI keys. Without it users cannot save personal keys | empty |
| `AI_DEFAULT_PROVIDER` | default provider id | `groq` |
| `AI_DEFAULT_MODEL` | default model id. **No model is built in**: use a current id from your provider's docs, or set it in Assistant > Settings (admin) | empty |
| `GROQ_API_KEY` | the owner's shared key. Server only | empty |
| `GROQ_BASE_URL` | override the Groq API base URL (testing) | Groq's URL |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET` | public values for photo upload | empty |
| `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | reserved for future signed uploads. Not used. Never put in frontend code | empty |

## 6. How things work (short versions)

- **Dashboard** (`dashboard/`): sign-in, then Home (greeting, widgets from installed apps), Assistant, Reports, Apps. All data comes from the API; widgets come from app manifests.
- **Applications/modules** (`apps/<id>/`): a folder with `manifest.json`, a frontend and an optional `server/index.js`. Discovered at startup; nothing is hard-coded. Adding one: `docs/ADDING_A_NEW_APPLICATION.txt`, which includes a complete, tested "Tasks" example.
- **Installation:** Apps page > Install (admin). It writes one record in `app_installations` and adds the app's default permissions to roles. States: available, installed, enabled, disabled. Uninstalling never deletes source code or user data. An app's routes, screens, widgets, AI tools and reports only work while it is installed and enabled.
- **Authentication:** email + password (scrypt hashed), random session token in an HttpOnly cookie (only its hash is stored), login throttling, CSRF protection. No public sign-up: admins create accounts.
- **Roles and permissions:** roles `admin` (everything), `resident` (AI use plus whatever installed apps grant), `guest` (nothing until granted). Permissions are strings like `inventory.item.read`; effective permissions are role plus per-user grants minus per-user denies. Enforced on the server for every request. Nobody can grant what they do not hold; you cannot change your own role; the last admin is protected.
- **Public/private profile data:** each profile field is public, shared with named users, or private. The AI uses the same check, so it can never show you more than you could see yourself.
- **Inventory:** private per user (even admins cannot see another user's items). Items follow the schema in `docs/DATA_MODEL.md`. Archive before permanent delete. History is recorded automatically. Export/import your own data as JSON from the Inventory screen.
- **AI system:** `docs/AI_ARCHITECTURE.md`. Short version: the model can only *ask* for tool calls; the server validates and runs them with your permissions; it never gets database access or code execution.
- **Groq:** wrapped by `ai/providers/groq.js` behind an `AIProvider` interface; nothing else in the code knows about Groq. Replaceable by adding a provider file.
- **AI conversations:** stored per user in `ai_conversations` and `ai_messages`; only the last 20 messages are sent to the model.
- **Database:** SQLite through a storage interface (`database/storage.js`). Each collection is a table of JSON documents; the file is created automatically at `SQLITE_PATH`. Nothing to set up.

## 7. AI setup

In `.env`: `GROQ_API_KEY`, `AI_DEFAULT_MODEL` and (if users may save their own keys) `KEY_ENCRYPTION_SECRET`:
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Restart, open Assistant > Settings. Each user picks the ecosystem key (daily message cap, default 50, adjustable by admins) or their own key. Keys are never shown after saving. Then do the first-run check in `docs/AI_ARCHITECTURE.md`.

## 8. Photos (Cloudinary, optional)

1. Create a Cloudinary account; note the **cloud name**.
2. Settings > Upload > Upload presets > Add: signing mode **Unsigned**, allowed formats `jpg,png,webp,gif`, file size limit, and a folder.
3. Set `CLOUDINARY_CLOUD_NAME` and `CLOUDINARY_UPLOAD_PRESET` in `.env`; restart.
Browsers upload straight to Cloudinary; the server stores only metadata and rejects URLs from any other cloud. Anyone who learns the preset name can upload to it, so keep limits on the preset. Signed uploads are the planned upgrade.

## 9. Administering users and roles (API, until a screen exists)

Sign in once and keep the cookie, then call the API. Every change request needs the two headers shown.
```
H='-H X-Requested-With:universe -H Content-Type:application/json'
curl -c jar $H -d '{"email":"you@example.com","password":"..."}' http://127.0.0.1:3000/api/auth/login
curl -b jar $H -d '{"email":"sam@example.com","displayName":"Sam","password":"a-long-password","roleId":"resident"}' http://127.0.0.1:3000/api/users
curl -b jar http://127.0.0.1:3000/api/users            # list users (ids)
curl -b jar http://127.0.0.1:3000/api/roles            # roles and their permissions
curl -b jar http://127.0.0.1:3000/api/permissions      # every permission that exists
curl -b jar $H -X PATCH -d '{"grants":["inventory.item.read"]}' http://127.0.0.1:3000/api/users/<id>   # give one user one permission
curl -b jar $H -X PATCH -d '{"status":"disabled"}' http://127.0.0.1:3000/api/users/<id>               # disable (also ends their sessions)
curl -b jar http://127.0.0.1:3000/api/audit            # audit log
```
Residents can change their own display name, bio, avatar and visibility from the API (`PATCH /api/me`, `PUT /api/me/visibility`) and password (`POST /api/auth/change-password`); there are no screens for these yet.

## 10. Build

There is no build step: the dashboard and apps are plain files served as they are.

## 11. Deploy (untested instructions)

I have not deployed this anywhere. These are the requirements, not a verified recipe.
1. A host that runs Node 22.5+ with a **persistent disk** for the SQLite file (a host with an ephemeral disk will lose your data).
2. Copy the repository, create `.env` with `NODE_ENV=production`, `HOST=0.0.0.0`, `SQLITE_PATH` on the persistent disk, `TRUST_PROXY=true` (only if exactly one proxy is in front), plus your admin, AI and Cloudinary settings.
3. Terminate HTTPS at a reverse proxy or the host's edge (production cookies are `Secure`, so the app does not work over plain HTTP in production).
4. `npm start` under a process manager that restarts it.
5. Back up the database regularly (`npm run export -- file.json` with the server stopped, or copy the `.db` file while stopped). Run a single instance: rate limits and some locking are in memory.

### 11b. Free hosting: Render + data in a private GitHub repo (`STORAGE_DRIVER=github`)

Render's free web service has no persistent disk, so SQLite would be wiped on every restart. The `github` driver keeps the whole database in memory and saves it as one JSON file in a GitHub repo (same format as `npm run export`). Images stay on Cloudinary; only their URLs are saved.

1. Create a **private** GitHub repo (for example `universe-data`) and add a README so it is not empty. The data file holds password hashes and encrypted API keys, so it must never be public.
2. Create a fine-grained personal access token: only that repo, permission **Contents: Read and write**, nothing else.
3. On Render: New > Web Service from your code repo. Build command empty, start command `npm start`, and set `NODE_VERSION=22`.
4. Environment variables on Render:
   - `NODE_ENV=production`, `HOST=0.0.0.0`, `TRUST_PROXY=true`
   - `STORAGE_DRIVER=github`, `GITHUB_TOKEN=...`, `GITHUB_REPO=your-name/universe-data`
   - `KEY_ENCRYPTION_SECRET`, `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, the AI keys and the Cloudinary settings
5. After the first successful sign-in, delete `BOOTSTRAP_ADMIN_PASSWORD` from Render.

How it behaves:
- Data is saved to the branch `universe-data` (created automatically), at most one commit every 3 seconds, and again on shutdown. A hard crash can lose the last few seconds.
- Run exactly **one** instance. Two servers would overwrite each other.
- The free service sleeps after 15 minutes without traffic and takes about a minute to wake. It reloads everything from GitHub when it wakes. Sessions are saved too, so you stay signed in.
- If the file is edited on github.com while the server runs, the server's copy wins on its next save. If the file is corrupt, the server refuses to start rather than overwrite it.
- The limits that matter are GitHub's: about 5,000 API calls an hour, and a data file under 100 MB. Both are far above personal use.
- To move to SQLite later: `npm run export -- backup.json` with the github settings, then switch `STORAGE_DRIVER=sqlite` and `npm run import -- backup.json`.

### 11c. Accounts, sign-up and settings

- **New visitors** open the sign-in screen (the dashboard or any app) and tap **Create account**. They are signed in straight away and get the role in `SIGNUP_ROLE` (default `resident`). Sign-up can never create an admin.
- New accounts do **not** get the assistant by default, so strangers cannot spend your shared AI key. Turn it on for everyone with `SIGNUP_ALLOW_AI=true`, or per person in Settings > People.
- **Admins** change all of this at **Settings > Sign-ups** without redeploying: close sign-ups, choose the role, allow the assistant.
- **Settings > People** (admins): see everyone, change a role, block or unblock an account, allow or remove assistant access, **set a new password** for someone who forgot theirs (it signs them out everywhere), and add accounts by hand.
- **Everyone** can change their name and password in Settings (the dashboard and each app have their own Settings page).
- There is no email, so there is no "forgot password" link: an admin sets a new password and tells the person.
- Sign-ups are limited to 10 per IP per hour (`rateLimits.signup`).

### 11d. Installing the apps (PWA)

The dashboard and each app are separate installable apps with their own icon, window and scope: the dashboard is `/dashboard/`, Inventory is `/apps/inventory/`. Open either in Chrome, Edge or Android Chrome and use Settings > Install (or the Install button in the sidebar or top bar). On iPhone: Share > Add to Home Screen. Installing needs HTTPS (Render gives you that) or `localhost`.

Each app signs in on its own screen and has its own navigation and Settings, so it works with no link back to the dashboard. The session cookie is shared, so signing in once covers every app on the same server.

Each app ships `app.webmanifest`, `sw.js` and `icons/`. The service worker keeps the app's own files so it opens fast and shows its shell offline. It never caches `/api/` data.

### 11e. Photos (Cloudinary)

Photos are uploaded straight from the browser to Cloudinary; only the link is saved. Phone photos are shrunk to about 1600 px first. Needed on the server: `CLOUDINARY_CLOUD_NAME` and `CLOUDINARY_UPLOAD_PRESET`. **The preset must be set to Unsigned**: in Cloudinary open Settings > Upload > Upload presets, pick the preset, and set Signing mode to Unsigned (the built-in `ml_default` is usually Signed). Do not put your Cloudinary API secret on the server; it is not used.

## 12. Security notes

- Secrets live only in `.env` / the host's secret store. `.env` is git-ignored. Never commit it or paste keys in chat, screenshots or tickets.
- The shared AI key and users' own keys never reach the browser; own keys are encrypted at rest (AES-256-GCM). If you change `KEY_ENCRYPTION_SECRET`, saved personal keys stop working.
- Authorization is enforced on the server for every API call; the UI hides things only for convenience.
- Export files contain password hashes and encrypted keys: treat them like passwords.
- Rate limits are in memory and per process. A person can lock out a given email address for 15 minutes by failing logins on purpose.
- The browser screens use `textContent` (never `innerHTML`), a strict Content-Security-Policy, and a CSRF header. There is no automated browser test and no third-party security review.
- Cloudinary unsigned presets are usable by anyone who knows the preset name.
- AI: users can change their own assistant's instructions; a manipulated model can say wrong things but cannot do more than the user's permissions allow.

## 13. Moving to a private home server

Documented step by step in `docs/ARCHITECTURE.md`, section 11. In short: stop the server, `npm run export -- backup.json`, move the file securely, set up `.env` on the home server (same `KEY_ENCRYPTION_SECRET`), `npm run import -- backup.json`, start. Images stay on Cloudinary and AI stays on Groq until local replacements are written (Not built).

## 14. Tests

`npm test` (about 60 tests): storage, auth, permissions, isolation between users, install lifecycle, Inventory, AI, reports, and the Tasks example app. Not covered: the browser screens, real Groq, real Cloudinary.
