/**
 * AIProvider interface (provider-neutral):
 *   id: string
 *   chat({ apiKey, model, messages, tools }) -> { content, toolCalls: [{id,name,arguments(JSON string)}], usage|null }
 *     messages: { role: 'system'|'user'|'assistant'|'tool', content, toolCalls?, toolCallId? }
 *     tools:    [{ name, description, parameters(JSON schema) }]
 *   throws ProviderError(kind) with kind in auth | rate_limit | bad_request | unavailable
 * Adding a provider = one file implementing this + registering it below. Nothing else changes.
 */
import { GroqProvider } from './groq.js';

export class ProviderRegistry {
  constructor(config, extra = {}) {
    this.map = new Map([['groq', new GroqProvider({ baseUrl: config.ai.groqBaseUrl })]]);
    for (const [id, p] of Object.entries(extra)) this.map.set(id, p);
  }
  get(id) { return this.map.get(id) || null; }
  list() { return [...this.map.keys()]; }
}
