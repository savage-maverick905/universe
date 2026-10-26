// Groq speaks the OpenAI-compatible chat API. Everything Groq-specific stays in this file.
export class ProviderError extends Error {
  constructor(kind, status = null) { super(`AI provider error: ${kind}`); this.kind = kind; this.status = status; }
}
// Function names must match ^[a-zA-Z0-9_-]+$ on the wire, but our tool names contain dots.
const toWire = (n) => n.replace(/\./g, '__');
const fromWire = (n) => n.replace(/__/g, '.');

export class GroqProvider {
  id = 'groq';
  constructor({ baseUrl = 'https://api.groq.com/openai/v1', timeoutMs = 45_000, retryDelayMs = 1500, maxWaitMs = 6000 } = {}) { this.baseUrl = baseUrl; this.timeoutMs = timeoutMs; this.retryDelayMs = retryDelayMs; this.maxWaitMs = maxWaitMs; this.lanes = new Map(); }

  // One request at a time per API key, with a small gap, so a burst never trips the provider's per-minute limits.
  lane(key, fn) {
    const prev = this.lanes.get(key) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => fn()).finally(() => { if (this.lanes.get(key) === run) this.lanes.delete(key); });
    this.lanes.set(key, run.then(() => new Promise((r) => setTimeout(r, Math.min(300, this.retryDelayMs))), () => {}));
    return run;
  }

  async chat({ apiKey, model, messages, tools = [] }) {
    const body = { model, messages: messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant' && m.toolCalls?.length) return { role: 'assistant', content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: toWire(c.name), arguments: c.arguments } })) };
      return { role: m.role, content: m.content };
    }) };
    if (tools.length) { body.tools = tools.map((t) => ({ type: 'function', function: { name: toWire(t.name), description: t.description, parameters: t.parameters } })); body.tool_choice = 'auto'; }
    const res = await this.lane(apiKey, () => this.send(apiKey, body));
    if (!res.ok) throw new ProviderError(res.status === 401 || res.status === 403 ? 'auth' : res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'unavailable' : 'bad_request', res.status);
    const json = await res.json().catch(() => null);
    const msg = json?.choices?.[0]?.message;
    if (!msg) throw new ProviderError('unavailable', res.status);
    return {
      content: msg.content || '',
      toolCalls: (msg.tool_calls || []).map((c) => ({ id: c.id, name: fromWire(c.function?.name || ''), arguments: c.function?.arguments || '{}' })),
      usage: json.usage ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens, totalTokens: json.usage.total_tokens } : null,
    };
  }

  // Rate limits (429) and brief outages (5xx) are retried, waiting as long as the provider asks (capped), instead of failing the message.
  async send(apiKey, body) {
    let res;
    for (let attempt = 0; ; attempt++) {
      try { res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) }); }
      catch { if (attempt < 1) { await sleep(this.retryDelayMs / 2); continue; } throw new ProviderError('unavailable'); }
      const limited = res.status === 429, down = res.status >= 500;
      if (!(limited || down) || attempt >= (limited ? 3 : 1)) return res;
      const ra = Number(res.headers.get('retry-after')), asked = Number.isFinite(ra) && ra > 0 ? ra * 1000 : this.retryDelayMs * (attempt + 1);
      if (asked > this.maxWaitMs && limited) return res; // the provider wants a long pause: tell the person instead of hanging
      await sleep(limited ? asked : this.retryDelayMs / 2);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
