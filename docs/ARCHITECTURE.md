# Universe: Architecture (all six phases)

Status labels: **Implemented** / **Partial** / **Planned**. All six build phases are done. Implemented and tested: storage interface + SQLite driver + JSON export/import, authentication, sessions, roles/permissions, profile visibility, audit log, rate limiting, CSRF protection, app registry and install system, dashboard, widgets, Inventory app with Cloudinary photos, AI assistant layer, reporting. **Not verified:** real calls to Groq and Cloudinary (tested only against mocks or not at all), a real cloud deployment, and the browser screens (no browser tests exist). **Not built:** admin screens for users and roles (use the API), per-app install/upgrade hooks and a migration runner, item sharing between users, AI write tools, per-user time zones, local media/AI providers. Each section below says what applies.

## 1. Layers

```
Browser (dashboard + app UIs: HTML/CSS/vanilla JS)
        |  HTTPS, JSON, session cookie
        v
API layer (Express routes, validation, authN/authZ, rate limits)
        |
        v
Services (auth, users, permissions, app registry, AI orchestrator, reports, media)
        |
        v
Storage interface  --->  SQLite driver (V1)  |  Home-server driver (future)
```

Rules:
- The frontend never talks to a database, Groq, or any vendor API with secrets. Only the API.
- Authorization is enforced in services/API, never only in the UI.
- Services depend on the **storage interface**, not on SQLite. Swapping the driver must not touch app code.
- Apps depend on core services via a small context object (`ctx`), not on each other.

## 2. Repository layout

| Path | Purpose |
|---|---|
| `dashboard/` | Dashboard UI (shell, widgets host, apps page, AI panel) |
| `apps/<id>/` | One folder per app: `manifest.json`, `index.html`, `app.js`, `styles.css`, `components/`, `services/`, `README.md`, server module |
| `core/` | App registry, manifest validation, widget/report/tool registries |
| `api/` | HTTP server, routing, middleware |
| `auth/` | Passwords, sessions, role/permission checks |
| `ai/` | Orchestrator, `providers/` (Groq first), `tools/` |
| `shared/` | Design tokens, UI primitives, utilities used by dashboard and apps |
| `database/` | Storage interface (`storage.js`), drivers (`drivers/sqlite.js`), migrations (empty so far), JSON export/import |
| `config/` | Non-secret configuration |
| `docs/` | Documentation |
| `public/` | Static assets |

## 3. Application module contract (Implemented)

Every app has `manifest.json` validated against `core/schemas/app-manifest.schema.json`. It declares id, name, version, entry, permissions, default role grants, owned data resources, dashboard widgets, AI tools, and reports. The registry discovers apps by scanning `apps/*/manifest.json`; nothing is hard-coded in the dashboard.

## 4. Registry, installation, dashboard (Implemented: Phase 3)

- `core/registry.js` scans `apps/*/manifest.json` at startup, validates it (id equals folder name; permissions, data resources, AI tools and widget endpoints must live inside the app's own namespace) and skips invalid apps with a warning. App permissions are registered so admins can grant them. Restart the server to pick up a new app.
- `core/installer.js` stores one row per app in `app_installations` (`id, version, enabled, installedBy, installedAt`). Available = no row; Installed = row; Enabled/Disabled = flag. Uninstall deletes only the row: source code and user data stay. Install adds the manifest's `defaultRolePermissions` to roles additively (locked roles untouched, nothing removed). Installation is **ecosystem-wide**, admin-only (`apps.manage`).
- Not yet implemented: running per-app data migrations on install, and version upgrades (a newer manifest version than the installed one is ignored for now).
- Static serving (`api/static.js`): dashboard at `/`, shared assets at `/shared/`, and an app's files at `/apps/<id>/` **only while installed and enabled**. Never served: dotfiles, `node_modules`, and any `server/` folder, so put an app's backend code in `apps/<id>/server/`.
- API: `GET /api/apps` (any signed-in user), `POST /api/apps/:id/{install,enable,disable,uninstall}` (`apps.manage`), `GET /api/dashboard/widgets` (widgets of active apps the user's permissions allow).
- Widget data contract, by manifest `type`: `stat` returns `{stats:[{label,value}]}`, `list` returns `{items:[{title,subtitle?}]}`, `chart` returns `{series:[{label,value}]}`. The dashboard fetches each `dataEndpoint` itself, so authorization is enforced by that endpoint. A widget whose endpoint does not exist yet shows "No data yet".
- Dashboard UI (`dashboard/`, `shared/theme.css`): vanilla JS, sign-in, Home (assistant placeholder + widgets), Apps (Install, Open, Installed, Enable/Disable, Uninstall). It builds DOM with `textContent` only. Not yet built: recent activity, notifications, quick actions, ecosystem statistics, profile editing UI.

## 4b. Inventory app and app backends (Implemented: Phase 4)

- An app's backend lives in `apps/<id>/server/index.js` and exports `register({router, services, app})`. `core/appLoader.js` loads it at startup; its routes must be under `/api/apps/<id>/` and answer 404 unless the app is installed and enabled. The `server/` folder is never served to browsers.
- Inventory API (all under `/api/apps/inventory`, all scoped to the signed-in user): `GET /meta`; items `GET/POST /items`, `GET/PATCH/DELETE /items/:id`, `POST /items/:id/{archive,restore,history}`; `GET/POST /categories`, `PATCH/DELETE /categories/:id`; same for `/locations`; `GET /stats/{summary,by-category,by-location,recent}` (the four dashboard widgets); `GET /export`, `POST /import`. Permissions: `inventory.item.{read,write,delete}`, `inventory.category.manage`, `inventory.location.manage`, `inventory.stats.read`.
- List endpoint supports `q, status, category, location, tag, archived, sort (name|createdAt|updatedAt|price), dir, limit, offset`. Filtering runs in memory over the user's own items, which is fine at personal scale; revisit if a user has tens of thousands of items.
- Cloudinary: `GET /meta` returns only public settings (cloud name, upload preset, folder, size limit). The browser (`apps/inventory/services/media.js`) uploads straight to Cloudinary with an unsigned preset; CSP allows `https://api.cloudinary.com`. The server then validates the returned metadata. Replace `UnsignedCloudinaryUploader` with a signed one (server endpoint that signs; secret stays in env) without touching the rest of the app.
- Not yet: item sharing between users, document attachments, AI tools and report providers for Inventory (declared in the manifest, wired in Phases 5 and 6), per-user dashboard activity feed.

## 5. Auth, permissions, storage (Implemented: Phase 2)

### Dependencies decision
Zero npm dependencies. Node >= 22.5 built-ins only: `node:sqlite`, `node:crypto` (scrypt), `node:http`, `node:test`. This keeps the home-server move simple (no native builds). Trade-off: `node:sqlite` is still flagged experimental by Node (prints a warning), and the hand-written router/validators are small and deliberately minimal. If either becomes a burden, the storage driver and HTTP layer are isolated and replaceable.

### Storage (`database/`)
Document-style interface (`insert/get/find/update/delete/count/upsert`, `transaction`, `exportAll/importAll`) documented at the top of `database/storage.js`. The SQLite driver stores each collection as a table of JSON documents. Field names are regex-validated before use in SQL, values are always bound parameters. `exportAll` excludes `sessions` by default; note exports contain password hashes, so treat export files as secrets. Transaction callbacks must only await storage calls.

### Authentication (`auth/`, `http/routes/auth.js`)
- Passwords: scrypt (N=32768, r=8, p=1), per-password random salt, constant-time compare, 10-128 chars. Unknown emails still run a dummy hash so timing does not reveal valid accounts.
- Sessions: 256-bit random opaque token in an `HttpOnly; SameSite=Lax` cookie (`Secure` in production). Only the SHA-256 of the token is stored. Default lifetime 7 days (absolute). Logout, password change (other sessions), disabling a user, or changing a user's role/permissions revokes sessions.
- Login throttling: per-IP (all attempts) and per-email (failed attempts, 5 per 15 min). Known trade-off: someone can deliberately lock out a victim's email for 15 minutes.
- No public sign-up. Admins create accounts. Accounts are disabled, not deleted, until data-ownership rules exist for apps.
- First admin comes from `BOOTSTRAP_ADMIN_*` env vars, only when the database has zero users.

### Authorization (`auth/permissions.js`)
- Roles are data (`roles` collection): `admin` (`*`, locked), `resident` (`ai.use`), `guest` (nothing). Admins can create more roles.
- Permission strings: `app.resource.action`. `*` and `app.*` wildcards. Effective = role + per-user `grants` - per-user `denies`. Disabled users have none.
- Apps register permissions from their manifest into `PermissionRegistry`; an app can only define permissions inside its own namespace. Admins can only grant registered permissions. (Registration from manifests is wired up in Phase 3.)
- Anti-escalation: nobody can grant a permission or assign a role they do not hold; users cannot change their own role/status/grants; privileged users (admin or anyone with users/roles/apps/config manage) can only be modified by someone holding all their permissions; the last active admin cannot be removed.
- Identity always comes from the session. Request bodies are checked against allow-lists of keys, so unknown fields (e.g. `roleId`, `ownerId`) are rejected.

### Profile visibility (`auth/visibility.js`)
Per-field rule: `public`, `shared` (explicit user ids) or `private`. Defaults: displayName and avatar public, bio private. `canView(viewer, owner, field)` is the single check; Phase 5 AI tools must call it. Note: admins see account basics (email, role, display name) for management, but not private profile fields.

### HTTP hardening (`http/middleware.js`)
Security headers incl. CSP and `no-store`; global rate limit; body size limit (100 KB); JSON-only bodies; state-changing requests require `X-Requested-With: universe` and a matching `Origin` if one is sent; no CORS. Rate limiting is in-memory and per-process.

### API (all JSON, all under `/api`)

| Method + path | Needs | Notes |
|---|---|---|
| POST `/auth/login` | none | sets session cookie |
| POST `/auth/logout` | login | |
| GET `/auth/me` | login | user, effective permissions |
| POST `/auth/change-password` | login | needs current password |
| PATCH `/me` | login | displayName, avatarUrl (https), bio |
| PUT `/me/visibility` | login | per-field rules |
| GET `/users/:id/profile` | login | only fields the owner exposes |
| GET `/users`, GET `/users/:id` | `users.read` (self allowed for `:id`) | |
| POST `/users`, PATCH `/users/:id` | `users.manage` | anti-escalation rules above |
| GET `/permissions`, GET `/roles` | `users.read` | |
| POST/PATCH/DELETE `/roles` | `roles.manage` | admin role locked, system roles undeletable |
| GET `/audit` | `audit.read` | passwords/tokens/keys redacted from metadata |
| GET `/healthz` (no `/api`) | none | |

## 6. AI layer (Implemented: Phase 5; real Groq calls not yet verified)

Full details in `docs/AI_ARCHITECTURE.md`. Summary: `ai/orchestrator.js` runs a bounded chat loop; models are reached only through the `AIProvider` interface (`ai/providers/`, Groq first); a model can only *request* tool calls, which `ai/tools.js` validates and executes server-side with the signed-in user's permissions; app tools come from manifest `aiTools` declarations; cross-user data goes only through `auth/visibility.js`. Conversations, messages, profiles and usage are stored per user (`ai_*` collections). Users choose the ecosystem key (daily cap) or their own key (AES-256-GCM at rest). API: `/api/ai/{profile,key,providers,conversations,chat,admin/config}`.

## 7. Media (Implemented for Inventory: Phase 4)

Browser uploads to Cloudinary with an unsigned preset restricted to images, size-limited, foldered, and tagged. Only metadata is stored (public ID, secure URL, resource type, dimensions, format, timestamp). Uploads go through a single `MediaUploader` interface so signed uploads can replace unsigned ones without touching Inventory. The API secret never reaches frontend code.

## 8. Dashboard widgets and reports (Implemented)

**Widgets:** declared in manifests, listed per user by `GET /api/dashboard/widgets` (active apps only, filtered by the widget's `requiredPermission`). The dashboard fetches each `dataEndpoint` itself, so the endpoint enforces authorization. Shapes: `stat` `{stats:[{label,value}]}`, `list` `{items:[{title,subtitle}]}`, `chart` `{series:[{label,value}]}`.

**Reports (`core/reports.js`, `http/routes/reports.js`, `dashboard/reports.js`):**
- Periods: `daily` (today), `weekly` (last 7 days), `monthly` (last 30), `yearly` (last 365), `last_days` (N, 1 to 3660), `custom` (from/to, at most 3660 days). Dates are UTC calendar dates and inclusive. Per-user time zones are Planned.
- Providers: an app declares `reports` in its manifest (id, title, requiredPermission) and registers a handler with `services.reports.registerApp(appId, reportId, {handler})`. The handler receives `{user, range, filters, services}` and returns `{title, sections}` where a section is any of `text`, `stats[{label,value}]`, `table{columns,rows}`. Filters understood today: `category` (name) and `status`.
- Scopes: one report by key (`inventory.inventory-overview`), one app (`app: "inventory"`), or everything the user may run (`report: "all"`, titled "Ecosystem report" when more than one app contributes). A report is available only if its app is active and the user holds its permission.
- Saved reports: `POST /api/reports/run` with `save: true` stores the result in `reports` (newest 50 per user kept); list/open/delete under `/api/reports/saved`. Owner-only.
- AI: the core tool `reports.generate` runs the same engine with the caller's permissions ("give me a report for the last 17 days" becomes `period: last_days, days: 17`).
- Inventory's report ("Inventory overview") has: current overview (as of now), activity in the period (items added, status changes, moves, notes, plus an events table), items needing attention, and counts by category.
- Not built: scheduled/emailed reports, exports to PDF/CSV, charts inside reports, per-user time zones.

## 9. Data flow

```
Browser ---(1) cookie + JSON--> http/server.js
   (2) security headers, rate limit, CSRF check, session -> user
   (3) router -> route handler (core route or an app's server/index.js)
   (4) handler: permission check -> validate body -> storage collection (always scoped to user)
   (5) JSON response
Assistant: /api/ai/chat -> orchestrator -> provider(model) -> tool request -> ToolRegistry (same permission + validation) -> same app functions -> result back to model -> reply stored
Reports:   /api/reports/run -> ReportRegistry -> each allowed app provider (scoped to user) -> sections
```
How apps use core services: an app's `register({router, services})` receives `services` (storage, permissions, audit, users, aiTools, reports, config). Apps never import each other and never touch another app's collections.

## 10. How the architecture evolves when apps are added
Add `apps/<id>/` with a manifest and `server/index.js` (see `docs/ADDING_A_NEW_APPLICATION.txt`). No core file changes: discovery, install state, permissions, widgets, AI tools, reports, navigation and static serving are all driven by the manifest. Namespacing rules (permissions, collections, routes, tools must start with the app id) keep apps from colliding. Known gaps that will matter as apps multiply: no per-app install/upgrade hook or migration runner, no per-user install, one shared Node process (a runaway app slows all), in-memory rate limiting.

## 11. Moving from cloud to a private home server

Design: `Frontend -> API -> services -> storage interface`, with third-party services behind small interfaces (storage driver, `AIProvider`, `MediaUploader`). The application data model is plain JSON documents, so the data moves as JSON.

Steps (tested: the export/import round trip; NOT tested: an actual deployment on a home machine):
1. On the home server install Node 22.5+ and copy the repository.
2. On the cloud copy: stop the server, then `npm run export -- backup.json` (uses the same `.env`). The file holds password hashes and encrypted API keys: transfer it securely and delete it afterwards.
3. On the home server create `.env`. Use the **same `KEY_ENCRYPTION_SECRET`**, otherwise users' saved personal API keys cannot be decrypted (they would have to re-enter them).
4. `npm run import -- backup.json`, then `npm start`. Users sign in with their existing passwords; sessions are not exported, so everyone signs in once.
5. Put a reverse proxy with HTTPS in front (set `NODE_ENV=production`, `HOST`, `TRUST_PROXY=true`), and arrange backups of the database file.
What changes at the boundaries: (a) storage driver: add another file in `database/drivers/` and set `STORAGE_DRIVER` (the SQLite driver already works on a home server, so a new driver is only needed if you want a different database); (b) images: Cloudinary stays a cloud service until a local `MediaUploader` and file store are written (Planned); stored image metadata would need a migration; (c) AI: Groq stays remote until a local provider (for example a model server on the LAN) is added to `ai/providers/` (Planned); (d) smart-home device integrations are Planned and would arrive as an app.

## 12. Environment variables

See `.env.example` (Implemented). Secrets live only in `.env` / host secret store.
