// Boundary to ONE service: the Brave Search API. Needs a key (free tier at
// api.search.brave.com). capability 'search' is how the digest and Nyo find
// it; the key lives in this pack's own table, never in env.
const BASE = 'https://api.search.brave.com/res/v1/web/search';

async function row(api) {
  return api.DB.prepare('SELECT api_key FROM plugin_brave_search_config WHERE id = 1').first().catch(() => null);
}
async function query(key, q, count) {
  const url = `${BASE}?q=${encodeURIComponent(q)}&count=${count}`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  });
  const text = await r.text().catch(() => '');
  let json = null; try { json = JSON.parse(text); } catch { /* prose */ }
  return { http: r.status, ok: r.ok, json, text };
}
const errOf = (r) => String(r.json?.message || r.json?.error?.detail || r.text || `HTTP ${r.http}`).slice(0, 200);
const shape = (json) => (json?.web?.results || []).map((x) => ({
  title: String(x?.title || '').trim(),
  url: String(x?.url || ''),
  source: x?.profile?.name || x?.meta_url?.hostname || null,
  published_at: x?.age || null,
  summary: String(x?.description || '').replace(/<[^>]+>/g, '').trim() || null,
})).filter((x) => x.title && x.url);

export const gateway = {
  slug: 'brave',
  service: 'Brave Search API (api.search.brave.com)',
  description: 'Web search. Needs a Brave Search API key (free tier available).',
  capability: 'search',
  modes: {
    status: async (api) => {
      const r = await row(api);
      return { connected: !!r?.api_key, label: 'Brave Search', note: r?.api_key ? null : 'no key yet' };
    },
    // Verify a key with one real query before it is stored.
    verify: async (api, input) => {
      const key = String(input?.api_key || '').trim();
      if (!key) return { ok: false, error: 'api_key required' };
      const r = await query(key, 'test', 1);
      return r.ok ? { ok: true } : { ok: false, error: errOf(r) };
    },
    probe: async (api) => {
      const r0 = await row(api);
      if (!r0?.api_key) return { ok: false, error: 'not connected' };
      const r = await query(r0.api_key, 'test', 1);
      return r.ok ? { ok: true, label: 'Brave Search' } : { ok: false, http: r.http, error: errOf(r) };
    },
    search: async (api, input) => {
      const q = String(input?.query || '').trim();
      if (!q) return { ok: false, error: 'query required' };
      const r0 = await row(api);
      if (!r0?.api_key) return { ok: false, error: 'Brave Search is not connected' };
      const limit = Math.min(Math.max(Number(input?.limit) || 5, 1), 20);
      const r = await query(r0.api_key, q, limit);
      if (!r.ok) return { ok: false, error: errOf(r) };
      return { ok: true, query: q, results: shape(r.json).slice(0, limit) };
    },
  },
};
