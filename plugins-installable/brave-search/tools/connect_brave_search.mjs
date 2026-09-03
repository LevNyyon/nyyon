export const def = {
  name: 'connect_brave_search',
  description: 'Connect Brave Search as a web search provider (key from api.search.brave.com, free tier). The key is verified with a real query before it is stored.',
  input_schema: { type: 'object', properties: { api_key: { type: 'string' } }, required: ['api_key'] },
};
export async function run(api, input) {
  const key = String(input?.api_key || '').trim();
  if (!key) return { ok: false, error: 'no api_key given' };
  const v = await api.gateway('brave', 'verify', { api_key: key });
  if (!v?.ok) return { ok: false, error: `Brave rejected the key: ${v?.error || 'no answer'}` };
  await api.db.prepare(
    'INSERT INTO plugin_brave_search_config (id, api_key, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET api_key=excluded.api_key, updated_at=excluded.updated_at',
  ).bind(key, Date.now()).run();
  await api.log('connected', {});
  return { ok: true, note: 'Brave Search connected. The digest and search_web use it from now on.' };
}
