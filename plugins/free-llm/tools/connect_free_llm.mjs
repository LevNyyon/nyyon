export const def = {
  name: 'connect_free_llm',
  description: "Connect a FREE model provider as this install's backup brain. provider 'gemini' (recommended — key at aistudio.google.com/apikey, no card, generous limits) or 'groq' (console.groq.com/keys, no card, tight per-minute limits). The right model is discovered for the key, verified with a real request, and the newly connected provider becomes the active one.",
  input_schema: {
    type: 'object',
    properties: {
      provider: { type: 'string', enum: ['gemini', 'groq'] },
      api_key:  { type: 'string', description: 'the provider API key' },
      model:    { type: 'string', description: 'optional — discovered automatically otherwise' },
    },
    required: ['provider', 'api_key'],
  },
};

export async function run(api, input) {
  const provider = String(input?.provider || '').trim().toLowerCase();
  const apiKey = String(input?.api_key || '').trim();
  if (!['gemini', 'groq'].includes(provider)) return { ok: false, error: 'provider must be gemini or groq' };
  if (!apiKey) return { ok: false, error: 'no api_key given' };

  // The provider's own gateway discovers which model this key can actually
  // hold a conversation with — names rot, discovery does not.
  let model = String(input?.model || '').trim();
  if (!model) {
    const d = await api.gateway(provider, 'discover', { api_key: apiKey });
    if (!d?.ok) return { ok: false, provider, error: d?.error || 'the provider rejected the key' };
    model = d.model;
  }

  const now = Date.now();
  await api.db.prepare(
    `INSERT INTO plugin_free_llm_providers (provider, api_key, model, active, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(provider) DO UPDATE SET api_key=excluded.api_key, model=excluded.model, active=1, updated_at=excluded.updated_at`,
  ).bind(provider, apiKey, model, now).run();
  // One active brain at a time — the newest connection wins until changed.
  await api.db.prepare('UPDATE plugin_free_llm_providers SET active = 0 WHERE provider != ?').bind(provider).run();

  const probe = await api.gateway(provider, 'probe', {});
  await api.log('connected', { provider, model, works: !!probe?.ok });
  return probe?.ok
    ? { ok: true, provider, model, note: `Connected and answering on ${model}. This is now the active backup brain.` }
    : { ok: false, provider, saved: true, error: probe?.error || 'saved, but the provider did not answer' };
}
