// Groq speaks the OpenAI-compatible chat API. Everything Groq-specific stays in this file.
export class ProviderError extends Error {
  constructor(kind, status = null) { super(`AI provider error: ${kind}`); this.kind = kind; this.status = status; }
}
// Function names must match ^[a-zA-Z0-9_-]+$ on the wire, but our tool names contain dots.
const toWire = (n) => n.replace(/\./g, '__');
const fromWire = (n) => n.replace(/__/g, '.');

export class GroqProvider {
  id = 'groq';
  constructor({ baseUrl = 'https://api.groq.com/openai/v1', timeoutMs = 60_000 } = {}) { this.baseUrl = baseUrl; this.timeoutMs = timeoutMs; }

  async chat({ apiKey, model, messages, tools = [] }) {
    const body = { model, messages: messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      if (m.role === 'assistant' && m.toolCalls?.length) return { role: 'assistant', content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: toWire(c.name), arguments: c.arguments } })) };
      return { role: m.role, content: m.content };
    }) };
    if (tools.length) { body.tools = tools.map((t) => ({ type: 'function', function: { name: toWire(t.name), description: t.description, parameters: t.parameters } })); body.tool_choice = 'auto'; }
    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch { throw new ProviderError('unavailable'); }
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
}
