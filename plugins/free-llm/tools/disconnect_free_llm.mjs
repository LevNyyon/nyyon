export const def = {
  name: 'disconnect_free_llm',
  description: "Forget one free provider's key (or every one of them when provider is omitted).",
  input_schema: {
    type: 'object',
    properties: { provider: { type: 'string', enum: ['groq'] } },
    required: [],
  },
};

export async function run(api, input) {
  const p = String(input?.provider || '').trim().toLowerCase();
  if (p) await api.db.prepare('DELETE FROM plugin_free_llm_providers WHERE provider = ?').bind(p).run();
  else await api.db.prepare('DELETE FROM plugin_free_llm_providers').run();
  await api.log('disconnected', { provider: p || 'all' });
  return { ok: true, note: p ? `${p} forgotten.` : 'All free providers forgotten.' };
}
