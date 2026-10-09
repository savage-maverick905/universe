# Universe: AI Architecture

Status labels: **Implemented** (built and tested with a fake provider and a mock HTTP server), **Planned**. The tools table and API list below are current as of all six phases.
**Not verified:** calls to the real Groq service. The Groq adapter is tested against a local mock of its OpenAI-compatible API, but nobody has run it against api.groq.com yet. Do that first (see "First real run" below).

## 1. How a user talks to their AI (Implemented)
Dashboard > **Assistant**. Each user has one personal assistant profile (`ai_profiles`): a **name** they choose, **personality/instructions**, **response style** (concise, balanced, detailed), **preferences** ("things it should know about me"), and an **AI access** choice. They can start a new chat, continue, rename and delete conversations. Requires the `ai.use` permission (admin and resident roles have it; guests do not unless granted).

```
Browser --> POST /api/ai/chat --> AiOrchestrator --> AIProvider (Groq) --> model
                                        ^   |
                                        |   v  "please call tool X with args Y" (a request, nothing more)
                                  ToolRegistry.execute()  (server-side, permission-checked, validated)
```

## 2. AI generating text vs AI requesting an action
- **Text:** the model's reply is stored and shown. Nothing happens because of it.
- **Action:** the model can only return a *tool-call request* (name + JSON arguments). The server decides whether it runs. The model never holds a database handle, never runs code, and never writes SQL. Each request goes through `ToolRegistry.execute()`, which: (1) checks the tool exists, its app is installed and enabled, and **the signed-in user** holds the required permission; (2) parses arguments and validates them against the tool's schema, rejecting unknown arguments; (3) runs a fixed server-side function with the user taken from the session; (4) caps the size of the result. Failures return a short error to the model, never a stack trace.
- **User identity is never an argument.** A model that adds `userId` to its arguments gets "unknown argument". Tools receive `{user}` from the session.
- **Writes:** the executor supports `access: "write"` tools (permission check, validation, audit log entry `ai.tool.write`), but **no write tools exist yet**. V1 tools are read-only.
- **Tool results are data, not instructions:** the system prompt tells the model to ignore instructions found inside tool output. This is a mitigation, not a guarantee, which is why safety does not depend on it: even a fully manipulated model can only call tools the user could already use, with arguments that are validated.
- Limits per message: at most 4 model/tool round trips, 4 tool calls per round trip; the last round offers no tools so a reply is always produced.

## 3. What the AI can reach (Implemented)
| Tool | Source | Permission | Notes |
|---|---|---|---|
| `inventory.search` | Inventory manifest | `inventory.item.read` | caller's own items only, max 20, compact fields |
| `inventory.getItem` | Inventory manifest | `inventory.item.read` | caller's own item by id |
| `inventory.getStatistics` | Inventory manifest | `inventory.stats.read` | same numbers as the dashboard widget |
| `users.findProfiles` | core | `ai.use` | other users, only fields they exposed to the caller |
| `reports.generate` | core | `ai.use` (each report also needs its own app permission) | runs the report engine as the caller: period, optional app, category, status; tables cut to 10 rows |

A tool is offered to the model only if its app is active and the user holds the permission, so a guest's assistant never even learns inventory tools exist. App tools must be declared in `manifest.json` (`aiTools`); the manifest supplies `access` and `requiredPermission`, so an app cannot register an undeclared tool. Not yet implemented: `dashboard.getStatistics`, `inventory.createItem/updateItem` (write).

## 4. Permissions and other users' data (Implemented)
Cross-user information flows only through `auth/visibility.js` (`canView`/`viewProfile`), the same check the profile API uses. If user B makes their display name private, A's assistant cannot find B at all; if B shares their bio with A only, only A's assistant can read it. This is tested end to end (`tests/ai.test.js`). **Rule for future apps:** any tool that returns another user's data must call a visibility check; never query another owner's records directly. Inventory is private per user, so no inventory tool reads anyone else's items. Note: today there is no "what is User B working on?" data source; that arrives when an app (such as projects or tasks) publishes shareable data with per-field visibility.

## 5. Provider abstraction (Implemented)
`ai/providers/index.js` documents the `AIProvider` interface: `chat({apiKey, model, messages, tools}) -> {content, toolCalls, usage}` and `ProviderError(kind)` with kinds `auth`, `rate_limit`, `bad_request`, `unavailable`. Messages and tools are provider-neutral; each provider converts to its own wire format. `GroqProvider` (`ai/providers/groq.js`) does the OpenAI-style conversion, maps dotted tool names (`inventory.search`) to wire-safe names (`inventory__search`) and back, and maps HTTP statuses to error kinds. Provider error bodies are never shown to users.

**Adding a provider:** create `ai/providers/<name>.js` implementing the interface, add it in `ProviderRegistry` (and a shared key entry in `config/env.js` if you want an ecosystem key). Admin and user settings list providers from the registry automatically. A local-model provider (Planned) fits the same interface.

## 6. API keys (Implemented)
- **Option A, ecosystem key:** the owner's key lives in the server environment (`GROQ_API_KEY`), is read only inside the orchestrator, and is never sent to a browser or returned by any endpoint (the admin screen shows only "configured: yes/no"). The assistant settings tell users it may have limits: a per-user **daily message cap** (default 50, admin-configurable, 0 = unlimited) applies only to the shared key. Admins can also switch shared access off.
- **Option B, own key:** the user pastes a key in settings. It is encrypted with AES-256-GCM using `KEY_ENCRYPTION_SECRET` (64 hex characters) before it is stored, decrypted only in memory at call time, never returned (the API exposes only `hasKey` and the last 4 characters), and never written to the audit log. Without `KEY_ENCRYPTION_SECRET` the server refuses to store keys. Removing a key deletes it. Losing or changing the secret makes stored keys unusable (users re-enter them); key rotation is Planned.
- **Option C, other providers:** selectable per user once a provider exists in the registry.
- The two modes never mix: in "own" mode the shared key is never used, and vice versa. If a user's own key fails, they see a message telling them to update it; the shared key is not used as a silent fallback.
- **No model is hard-coded.** Set `AI_DEFAULT_MODEL` (or an admin sets it in the UI) using a current model name from your provider's documentation, because model names change. Until then chat answers "No AI model is configured".

## 7. Conversation storage (Implemented)
| Collection | Fields |
|---|---|
| `ai_conversations` | id, userId, title, messageCount, summary (unused, Planned), timestamps |
| `ai_messages` | id, conversationId, userId, seq, role (`user`/`assistant`/`tool`), content, toolCalls[{id,name}], toolName, provider, model, usage{promptTokens,completionTokens,totalTokens}, createdAt |
| `ai_profiles` | id = userId, name, instructions, style, preferences, keyMode, provider, model, encryptedKey, keyLast4 |
| `ai_usage` | id = `<userId>_<date>`, messages, tokens (shared-key accounting) |

Every conversation query filters by the session user; another user's conversation id answers 404 (tested for read, rename, delete and continue). Deleting a conversation deletes its messages. **History sent to the model is bounded:** the system prompt, the most recent 20 plain user/assistant messages, and the new message. Older tool plumbing is not replayed. Conversation search and summarisation are Planned (the `summary` field is reserved).

## 8. Future (Planned, not built)
- **Memory:** per-user facts table fed by conversation summaries, retrieved selectively and shown/editable by the user; same bounded-context rule, never "send everything".
- **Agents:** multi-step workflows that still only act through registered tools with per-step permission checks; write tools would add a confirmation step shown to the user before executing.
- **Smart home:** device actions as tools from a future `home` app (`home.setLight`, etc.), declared in its manifest, `access: "write"`, with permission checks, argument validation, audit logging and user confirmation. Nothing in the AI layer changes except registering tools.

## 9. Known limits
- A user can write instructions that change their own assistant's behaviour; this cannot exceed their own permissions.
- Prompt injection can still make a model *say* misleading things; it cannot make the server do more than the user is allowed.
- Rate limiting is in-memory and per process; chat is limited to 20 requests per user per minute, one in-flight request per conversation.
- Tool results are truncated at about 6000 characters.

## First real run (do this once)
1. In `.env`: `GROQ_API_KEY`, `AI_DEFAULT_MODEL` (a current Groq model id), `KEY_ENCRYPTION_SECRET`.
2. Sign in, open Assistant, send "hello", then (with Inventory installed and some items) "what phones do I own?".
3. If you get "The AI provider rejected the request", check the model name; if "rejected the shared key", check `GROQ_API_KEY`.
