// Boundary to the operator's own social webhooks (Make.com or any endpoint
// that accepts JSON and posts on their behalf). One row per network in the
// pack's own table; nothing is hardcoded and no key lives in env.
const TIMEOUT = 20000;
async function conn(api, network) {
  return api.DB.prepare('SELECT name, url FROM plugin_editorial_connections WHERE name = ?').bind(String(network || '')).first().catch(() => null);
}
export const gateway = {
  slug: 'social',
  service: 'operator-owned social webhooks (LinkedIn, Facebook)',
  description: 'Posts through webhooks the operator connects. No account credentials ever reach this install.',
  modes: {
    connections: async (api) => {
      const r = await api.DB.prepare('SELECT name, url, updated_at FROM plugin_editorial_connections ORDER BY name').all().catch(() => null);
      const rows = r?.results || [];
      return { ok: true, connections: rows.map((x) => ({ network: x.name, connected: !!x.url, updated_at: x.updated_at })) };
    },
    post: async (api, input) => {
      const network = String(input?.network || '').trim();
      if (!network) return { ok: false, error: 'network required' };
      const c = await conn(api, network);
      if (!c?.url) return { ok: false, error: `${network} is not connected. Give Nyo the webhook URL for ${network} and it will connect it.` };
      try {
        const r = await fetch(c.url, {
          method: 'POST', signal: AbortSignal.timeout(TIMEOUT),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: input?.text ?? '', url: input?.url ?? null, image_url: input?.image_url ?? null, ...(input?.extra || {}) }),
        });
        const text = await r.text().catch(() => '');
        return r.ok ? { ok: true, network, response: text.slice(0, 300) } : { ok: false, network, error: `webhook answered HTTP ${r.status}: ${text.slice(0, 200)}` };
      } catch (e) { return { ok: false, network, error: String(e?.message || e).slice(0, 200) }; }
    },
  },
};
