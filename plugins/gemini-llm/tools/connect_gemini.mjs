export const def = {
  name: 'connect_gemini',
  description: "Connect Google Gemini as a backup brain for this install. Free key at aistudio.google.com/apikey (no card). The right model is discovered for the key and verified with a real request.",
  input_schema: {
    type: 'object',
    properties: {
      api_key: { type: 'string', description: 'the AIza... key from AI Studio' },
      model:   { type: 'string', description: 'optional — discovered automatically otherwise' },
    },
    required: ['api_key'],
  },
};

export async function run(api, input) {
  const apiKey = String(input?.api_key || '').trim();
  if (!apiKey) return { ok: false, error: 'no api_key given' };
  let model = String(input?.model || '').trim();
  if (!model) {
    const d = await api.gateway('gemini', 'discover', { api_key: apiKey });
    if (!d?.ok) return { ok: false, error: d?.error || 'Gemini rejected the key' };
    model = d.model;
  }
  await api.db.prepare(
    `INSERT INTO plugin_gemini_llm_config (id, api_key, model, active, updated_at) VALUES (1, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key, model=excluded.model, active=1, updated_at=excluded.updated_at`,
  ).bind(apiKey, model, Date.now()).run();
  const probe = await api.gateway('gemini', 'probe', {});
  await api.log('connected', { model, works: !!probe?.ok });
  return probe?.ok
    ? { ok: true, model, note: `Gemini connected on ${model}. Nyo uses it whenever the main model is unavailable.` }
    : { ok: false, saved: true, error: probe?.error || 'saved, but Gemini did not answer' };
}
