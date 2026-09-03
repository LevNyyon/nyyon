// Boundary to ONE service: SerpApi (google search results as JSON). The key
// lives in this pack's own table; the operator pastes it to Nyo. Fetch and
// translate only.
async function key(api) {
  const r = await api.DB.prepare("SELECT value FROM plugin_gtm_connections WHERE name = 'serp_api_key'").first().catch(() => null);
  return r?.value || null;
}
export const gateway = {
  slug: 'serp',
  service: 'SerpApi (serpapi.com)',
  description: 'Search-result lookups for prospecting. Needs a SerpApi key.',
  capability: 'search',
  modes: {
    status: async (api) => ({ connected: !!(await key(api)), label: 'SerpApi' }),
    search: async (api, input) => {
      const k = await key(api);
      if (!k) return { ok: false, error: 'SerpApi is not connected. Create a key at serpapi.com and paste it to Nyo.' };
      const q = String(input?.query || input?.q || '').trim();
      if (!q) return { ok: false, error: 'query required' };
      const num = Math.min(Math.max(Number(input?.limit || input?.num) || 10, 1), 20);
      const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=${num}&api_key=${encodeURIComponent(k)}`;
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
        const text = await r.text();
        let d = null; try { d = JSON.parse(text); } catch { /* not json */ }
        if (!r.ok) return { ok: false, error: String(d?.error || `HTTP ${r.status}`).slice(0, 200) };
        const results = (d?.organic_results || []).slice(0, num).map((x) => ({
          title: x?.title || '', url: x?.link || '', snippet: x?.snippet || null, position: x?.position ?? null,
        })).filter((x) => x.url);
        return { ok: true, query: q, results };
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    },
  },
};
