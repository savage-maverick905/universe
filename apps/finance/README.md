# Orbit — by Universe (`apps/finance`)

Personal finance inside Universe: accounts (cash, banks, OPay, PalmPay, Moniepoint, any custom one), nested categories, income/expense/transfer/refund/adjustment transactions, budgets, debts, goals, bills, net worth, reports, CSV import/export, backup/restore, and an AI assistant, all behind a separate **Finance PIN**.

## Use it
1. Set `KEY_ENCRYPTION_SECRET` on the server (Vercel env). Optional: `FINANCE_SECRET`.
2. Sign in to Universe as admin → **Apps** → **Install** Orbit. By default only admins hold the Orbit permissions. To let someone else use it, grant them `finance.access`, `finance.export` and `finance.ai` (plus `ai.use` for the assistant).
3. Open Orbit, create your PIN, add accounts, start recording.

## How it fits Universe
- Backend `server/index.js` registers under `/api/apps/finance/` (loaded by `core/appLoader.js`); data lives in `finance_*` collections of the existing storage (the single JSON file in your private GitHub repo). No core files were rewritten; the only core change is an optional `finance.secret` entry in `config/env.js`.
- Everything is scoped to the signed-in user (`ownerId`). There is **no** admin or cross-user route: another user's record answers 404.
- Orbit is deliberately **not** registered with Nebula's tools or the core Reports engine, because those run without the unlock cookie. Its dashboard widget shows only "Locked" / "Hidden" unless you are unlocked and switch it on.

## Security model (read this)
- The PIN is verified on the server: scrypt over `HMAC(pepper, pin)`; the pepper comes from the server environment, not the data repo. Wrong guesses are counted **in the database** (works across Vercel instances) with escalating delays: 5 wrong → 30 s, then 1 min, 5 min, 15 min, 1 h, 24 h.
- Unlocking sets an HttpOnly, SameSite=Strict, signed cookie bound to your user **and** your Universe session, with a sliding idle timeout (default 5 min, 1–60) and a hard maximum (default 12 h). Every sensitive request re-checks it. Locking, changing or resetting the PIN revokes every device.
- Forgot the PIN: reset with your Universe password (rate limited). Your records are untouched.
- **Limits:** the PIN is an access gate, not encryption. Data is plain JSON in your private GitHub repo; anyone with that repo, the GitHub token or the Vercel project can read it. Keep them private. Per-IP limits are in memory (per instance); the persisted lockout is the real control. Parallel guessing from many instances is bounded by GitHub's save conflicts, not eliminated.

## Money and accounting rules
Integer minor units everywhere (no floats). Transfers are one document touching both accounts (never half applied) and are not income/expense; fees are expenses. Refunds reduce spending in the original category (not income), capped at the purchase. Loans/borrowing/repayments are not income or expense; repayments cannot exceed what is outstanding. Gifts are ordinary income/expense. Adjustments are separate. Voided items are ignored. Reports bucket by the **local date** in your time zone (default Africa/Lagos). Different currencies are never converted or mixed.

## Nebula (the AI) lives in Universe
Orbit has no chat of its own. Ask **Nebula** in the Universe app (Assistant tab) about your money, or tell it what you spent.
- Reading figures: Nebula asks for your **Finance PIN** in a box (never in the chat). That unlocks Universe for a few minutes; it is a separate unlock from the Orbit app, and locking Orbit locks both.
- Adding transactions: Nebula only **prepares a draft**. Saving needs your PIN typed again, every time. The AI cannot write anything itself.
- Figures come from Orbit's own code (`finance.query`, `finance.recent`), never from the model's arithmetic. Names are resolved to your real accounts and categories by code; ambiguity becomes a question.
- What the AI provider sees: your question and the figures Orbit returns for it (for example a balance), because it must read them to answer. Nothing is sent while Orbit is locked.
- Orbit also appears in the Universe home stats and in Reports, both behind the same PIN. PIN-protected report sections are shown but never saved.

## Storage, concurrency, failure
Each request's writes are one `storage.transaction` and, on Vercel, one GitHub commit before the response is sent. If any step throws, memory rolls back and nothing is saved; if the commit fails the client gets an error (never a false success) and retries are safe thanks to idempotency keys. A concurrent change elsewhere gives HTTP 409 and nothing is overwritten. Edits require `expectedVersion`. Limits: the whole database is one file rewritten per save, so Orbit suits personal scale (roughly tens of thousands of transactions); attachments/receipts are not supported (Cloudinary is public-by-URL, unsuitable for financial documents); there is no offline queue (nothing financial is cached in the browser; the app shell is cached only); bills/subscriptions remind you in-app but are posted by you (no background worker on Vercel).

## Tests
`npm test` runs `finance-core.test.js` (maths), `finance.test.js` (API, PIN, access control, idempotency, debts, import/export, AI) and `finance-ui.test.js` (renders every screen against the API with a fake DOM; not a browser test).
