export const def = {
  name: 'set_active_free_llm',
  description: 'Choose which CONNECTED free provider is the active backup brain.',
  input_schema: {
    type: 'object',
    properties: { provider: { type: 'string', enum: ['groq'] } },
    required: ['provider'],
  },
};

export async function run(api, input) {
  const p = String(input?.provider || '').trim().toLowerCase();
  const row = await api.db.prepare('SELECT 1 AS x FROM plugin_free_llm_providers WHERE provider = ?').bind(p).first();
  if (!row) return { ok: false, error: `${p} is not connected` };
  await api.db.prepare('UPDATE plugin_free_llm_providers SET active = CASE WHEN provider = ? THEN 1 ELSE 0 END').bind(p).run();
  await api.log('active_changed', { provider: p });
  return { ok: true, active: p };
}
