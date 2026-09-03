// Boundary to ONE service: People Data Labs person enrichment. Key in the
// pack's own table, pasted to Nyo. Fetch and translate only.
async function key(api) {
  const r = await api.DB.prepare("SELECT value FROM plugin_gtm_connections WHERE name = 'pdl_api_key'").first().catch(() => null);
  return r?.value || null;
}
export const gateway = {
  slug: 'pdl',
  service: 'People Data Labs (api.peopledatalabs.com)',
  description: 'Person enrichment for prospecting. Needs a People Data Labs key.',
  modes: {
    status: async (api) => ({ connected: !!(await key(api)), label: 'People Data Labs' }),
    person: async (api, input) => {
      const k = await key(api);
      if (!k) return { ok: false, error: 'People Data Labs is not connected. Create a key at peopledatalabs.com and paste it to Nyo.' };
      const params = new URLSearchParams();
      for (const f of ['email', 'profile', 'phone', 'name', 'company', 'first_name', 'last_name']) {
        if (input?.[f]) params.set(f, String(input[f]));
      }
      if (![...params.keys()].length) return { ok: false, error: 'give at least one of email, profile, phone, or name plus company' };
      try {
        const r = await fetch(`https://api.peopledatalabs.com/v5/person/enrich?${params}`, {
          signal: AbortSignal.timeout(25000), headers: { 'X-Api-Key': k },
        });
        const text = await r.text();
        let d = null; try { d = JSON.parse(text); } catch { /* not json */ }
        if (r.status === 404) return { ok: true, found: false, person: null };
        if (!r.ok) return { ok: false, error: String(d?.error?.message || d?.error || `HTTP ${r.status}`).slice(0, 200) };
        return { ok: true, found: true, person: d?.data ?? d, likelihood: d?.likelihood ?? null };
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    },
  },
};
