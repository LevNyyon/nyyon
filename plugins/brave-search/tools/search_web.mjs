export const def = {
  name: 'search_web',
  description: 'Search the web (Brave). Returns titles, links, and one-line summaries. Use when the operator asks to look something up, find a page, or check what exists on a topic beyond the news.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'number', description: 'default 5, cap 20' } },
    required: ['query'],
  },
};
export async function run(api, input) {
  const r = await api.gateway('brave', 'search', { query: input?.query, limit: input?.limit });
  if (!r?.ok) return { ok: false, error: r?.error || 'search failed' };
  await api.log('searched', { query: r.query, results: r.results.length });
  return { ok: true, query: r.query, results: r.results };
}
