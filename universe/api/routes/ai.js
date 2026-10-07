import { v, allowKeys } from '../../shared/validate.js';
import { badRequest, HttpError } from '../../shared/errors.js';
import { AiOrchestrator } from '../../ai/orchestrator.js';
import { canEncrypt } from '../../ai/crypto.js';
import { tooMany } from '../middleware.js';

export function aiRoutes(router, s) {
  const { permissions, audit, ai } = s;
  const o = ai.orchestrator;
  const use = (u) => permissions.assert(u, 'ai.use');
  const provider = (x, name = 'provider') => { const p = v.string(x, name, { min: 1, max: 40 }); if (!ai.providers.get(p)) throw badRequest(`Unknown provider: ${p}`); return p; };

  router.add('GET', '/api/ai/providers', async ({ user }) => {
    await use(user);
    const a = await o.adminConfig();
    return { providers: ai.providers.list(), canStoreOwnKeys: canEncrypt(s.config.ai.keyEncryptionSecret),
      shared: { available: a.sharedKeyEnabled && !!s.config.ai.sharedKeys[a.defaultProvider] && !!a.defaultModel, dailyLimit: a.sharedDailyLimit, usedToday: await o.usedToday(user) } };
  });

  router.add('GET', '/api/ai/profile', async ({ user }) => { await use(user); return { profile: AiOrchestrator.publicProfile(await o.profileDoc(user)) }; });
  router.add('PUT', '/api/ai/profile', async ({ user, body, ip }) => {
    await use(user);
    const b = allowKeys(v.object(body), ['name', 'instructions', 'style', 'preferences', 'keyMode', 'provider', 'model']), patch = {};
    if ('name' in b) patch.name = v.string(b.name, 'name', { min: 1, max: 40 });
    if ('instructions' in b) patch.instructions = v.string(b.instructions, 'instructions', { max: 2000 });
    if ('style' in b) patch.style = v.enum(b.style, 'style', ['concise', 'balanced', 'detailed']);
    if ('preferences' in b) patch.preferences = v.string(b.preferences, 'preferences', { max: 1000 });
    if ('keyMode' in b) patch.keyMode = v.enum(b.keyMode, 'keyMode', ['shared', 'own']);
    if ('provider' in b) patch.provider = b.provider === null ? null : provider(b.provider);
    if ('model' in b) patch.model = b.model === null || b.model === '' ? null : v.string(b.model, 'model', { max: 100 });
    const saved = await o.saveProfile(user, patch);
    await audit.record({ actorId: user.id, action: 'ai.profile_update', meta: { fields: Object.keys(patch) }, ip });
    return { profile: AiOrchestrator.publicProfile(saved) };
  });

  router.add('PUT', '/api/ai/key', async ({ user, body, ip }) => {
    await use(user);
    if (!canEncrypt(s.config.ai.keyEncryptionSecret)) throw new HttpError(503, 'This server is not set up to store personal API keys (KEY_ENCRYPTION_SECRET is missing).', 'keys_unavailable');
    const b = allowKeys(v.object(body), ['apiKey', 'provider']);
    const key = v.string(b.apiKey, 'apiKey', { min: 8, max: 300 });
    if (/\s/.test(key)) throw badRequest('apiKey must not contain spaces');
    const saved = await o.setKey(user, provider(b.provider), key);
    await audit.record({ actorId: user.id, action: 'ai.key_set', meta: { provider: b.provider }, ip }); // never the key itself
    return { profile: AiOrchestrator.publicProfile(saved) };
  });
  router.add('DELETE', '/api/ai/key', async ({ user, ip }) => {
    await use(user);
    const saved = await o.saveProfile(user, { encryptedKey: null, keyLast4: null, keyMode: 'shared' });
    await audit.record({ actorId: user.id, action: 'ai.key_removed', ip });
    return { profile: AiOrchestrator.publicProfile(saved) };
  });

  router.add('GET', '/api/ai/conversations', async ({ user }) => {
    await use(user);
    const list = await o.convos.find({ where: { userId: user.id }, orderBy: { field: 'updatedAt', dir: 'desc' }, limit: 200 });
    return { conversations: list.map(({ id, title, messageCount, createdAt, updatedAt }) => ({ id, title, messageCount, createdAt, updatedAt })) };
  });
  router.add('GET', '/api/ai/conversations/:id', async ({ user, params }) => {
    await use(user);
    const c = await o.ownConvo(user, params.id);
    const messages = (await o.messagesOf(c)).map(({ id, seq, role, content, toolCalls, toolName, provider: p, model, createdAt }) => ({ id, seq, role, content, toolCalls, toolName, provider: p, model, createdAt }));
    return { conversation: { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt }, messages };
  });
  router.add('PATCH', '/api/ai/conversations/:id', async ({ user, params, body }) => {
    await use(user);
    const c = await o.ownConvo(user, params.id);
    const b = allowKeys(v.object(body), ['title']);
    const u = await o.convos.update(c.id, { title: v.string(b.title, 'title', { min: 1, max: 100 }) });
    return { conversation: { id: u.id, title: u.title } };
  });
  router.add('DELETE', '/api/ai/conversations/:id', async ({ user, params, ip }) => {
    await use(user); await o.deleteConvo(user, params.id);
    await audit.record({ actorId: user.id, action: 'ai.conversation_delete', targetType: 'conversation', targetId: params.id, ip });
    return { ok: true };
  });

  router.add('POST', '/api/ai/chat', async ({ user, body }) => {
    await use(user);
    const rl = s.limiters.ai.hit(user.id); if (!rl.allowed) throw tooMany(rl.retryAfterSec);
    const b = allowKeys(v.object(body), ['conversationId', 'message']);
    const message = v.string(b.message, 'message', { min: 1, max: 4000 });
    const conversationId = b.conversationId == null ? null : v.anyId(b.conversationId, 'conversationId');
    const r = await o.chat(user, { conversationId, message });
    return { conversation: { id: r.conversation.id, title: r.conversation.title }, reply: { id: r.reply.id, content: r.reply.content, provider: r.reply.provider, model: r.reply.model }, toolsUsed: r.toolsUsed };
  });

  // ---- admin defaults ----
  router.add('GET', '/api/ai/admin/config', async ({ user }) => {
    await permissions.assert(user, 'ai.configure_defaults');
    return { config: await o.adminConfig(), providers: ai.providers.list(), sharedKeyConfigured: Object.fromEntries(ai.providers.list().map((p) => [p, !!s.config.ai.sharedKeys[p]])) };
  });
  router.add('PUT', '/api/ai/admin/config', async ({ user, body, ip }) => {
    await permissions.assert(user, 'ai.configure_defaults');
    const b = allowKeys(v.object(body), ['defaultProvider', 'defaultModel', 'sharedKeyEnabled', 'sharedDailyLimit']), patch = {};
    if ('defaultProvider' in b) patch.defaultProvider = provider(b.defaultProvider, 'defaultProvider');
    if ('defaultModel' in b) patch.defaultModel = v.string(b.defaultModel, 'defaultModel', { min: 1, max: 100 });
    if ('sharedKeyEnabled' in b) { if (typeof b.sharedKeyEnabled !== 'boolean') throw badRequest('sharedKeyEnabled must be true or false'); patch.sharedKeyEnabled = b.sharedKeyEnabled; }
    if ('sharedDailyLimit' in b) { if (!Number.isInteger(b.sharedDailyLimit) || b.sharedDailyLimit < 0 || b.sharedDailyLimit > 100000) throw badRequest('sharedDailyLimit must be a whole number from 0 (unlimited) to 100000'); patch.sharedDailyLimit = b.sharedDailyLimit; }
    await o.saveAdminConfig(patch);
    await audit.record({ actorId: user.id, action: 'ai.admin_config', meta: patch, ip });
    return { config: await o.adminConfig() };
  });
}
