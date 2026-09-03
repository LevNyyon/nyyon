export const def = {
  name: 'search_news',
  description: 'Search recent news for any topic (Google News, no setup needed). Returns headlines with source, date and link. Use when the operator asks what is happening around a topic, company, or person.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'what to search for' },
      limit: { type: 'number', description: 'max results, default 5, cap 20' },
      lang: { type: 'string', description: "result language like en-US or he (default en-US)" },
      country: { type: 'string', description: 'two-letter country like US or IL (default US)' },
    },
    required: ['query'],
  },
};

export async function run(api, input) {
  const r = await api.gateway('google-news', 'search', { query: input?.query, limit: input?.limit, lang: input?.lang, country: input?.country });
  if (!r?.ok) return { ok: false, error: r?.error || 'search failed' };
  await api.log('searched', { query: r.query, results: r.results.length });
  return { ok: true, query: r.query, results: r.results };
}
