// Boundary to the public web. The host web gateway offers text and bytes; this
// pack also needs head (link checks) and post_json (publish webhooks), so it
// bundles its own. Fetch and translate only, never reasoning.
const TIMEOUT = 20000;
const strip = (html) => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

export const gateway = {
  slug: 'web',
  service: 'the public web (http(s) fetch: text, head, post_json)',
  description: 'Bounded fetch for public pages, link checks and outbound webhooks.',
  modes: {
    text: async (api, input) => {
      const url = String(input?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'http(s) url required' };
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; nyyon)' } });
        const body = await r.text();
        if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
        const looksHtml = /<html|<body|<div|<p[ >]/i.test(body);
        return { ok: true, status: r.status, url, text: looksHtml ? strip(body) : body, raw: body.slice(0, 200000) };
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    },
    head: async (api, input) => {
      const url = String(input?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'http(s) url required' };
      try {
        const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
        return { ok: r.ok, status: r.status, url: r.url, content_type: r.headers.get('content-type') || null };
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    },
    post_json: async (api, input) => {
      const url = String(input?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'http(s) url required' };
      try {
        const r = await fetch(url, {
          method: 'POST', signal: AbortSignal.timeout(TIMEOUT),
          headers: { 'Content-Type': 'application/json', ...(input?.headers || {}) },
          body: JSON.stringify(input?.body ?? {}),
        });
        const text = await r.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { ok: r.ok, status: r.status, body: json, text: json ? undefined : text.slice(0, 2000), error: r.ok ? null : `HTTP ${r.status}` };
      } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    },
  },
};
