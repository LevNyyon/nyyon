export const def = {
  name: 'connect_free_llm',
  description: "Connect a FREE model provider as this install's backup brain. provider is 'groq' (get a key at console.groq.com/keys, no card) or 'cloudflare' (Workers AI, needs account_id + an API token). The key is stored in this plugin's own table and verified with one real request before it is reported working.",
  input_schema: {
    type: 'object',
    properties: {
      provider:   { type: 'string', enum: ['groq', 'cloudflare'] },
      api_key:    { type: 'string', description: 'the provider API key' },
      model:      { type: 'string', description: 'optional; each provider has a sensible default' },
      account_id: { type: 'string', description: 'Cloudflare only: the account id' },
    },
    required: ['provider', 'api_key'],
  },
};

export async function run(api, input) {
  const provider = String(input?.provider || '').trim().toLowerCase();
  const apiKey = String(input?.api_key || '').trim();
  if (!['groq', 'cloudflare'].includes(provider)) return { ok: false, error: 'provider must be groq or cloudflare' };
  if (!apiKey) return { ok: false, error: 'no api_key given' };
  if (provider === 'cloudflare' && !String(input?.account_id || '').trim()) {
    return { ok: false, error: 'Cloudflare Workers AI needs account_id too' };
  }

  const now = Date.now();
  await api.db.prepare(
    `INSERT INTO plugin_free_llm_config (id, provider, api_key, model, account_id, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, api_key=excluded.api_key,
       model=excluded.model, account_id=excluded.account_id, updated_at=excluded.updated_at`,
  ).bind(provider, apiKey, String(input?.model || '').trim() || null, String(input?.account_id || '').trim() || null, now).run();

  // Saved is not the same as working. One tiny request decides which.
  const probe = await api.gateway('backup-llm', 'probe', {});
  await api.log('connected', { provider, model: probe?.model || null, works: !!probe?.ok });
  return probe?.ok
    ? { ok: true, provider, label: probe.label, model: probe.model, note: 'Connected and answering. Nyo uses this whenever the main model is unavailable.' }
    : { ok: false, provider, saved: true, error: probe?.error || 'the provider did not answer', note: 'The key was saved but the provider refused it. Check the key and try again.' };
}
