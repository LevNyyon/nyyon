// Boundary to ONE service: Google News RSS search. Zero configuration — no
// key, no account, plain worker fetch. capability 'search' is how the digest
// (and anything else) discovers it without knowing its name.
const BASE = 'https://news.google.com/rss/search';

// The feed is RSS 2.0. No DOM parser in a worker — a small tag reader is
// enough for the four fields we keep, and entities/CDATA are unwrapped.
function text(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

export const gateway = {
  slug: 'google-news',
  service: 'Google News (news.google.com RSS, keyless)',
  description: 'News search over Google News RSS. Zero setup: no key, no account.',
  capability: 'search',
  modes: {
    status: async () => ({ connected: true, label: 'Google News', note: 'keyless — always available' }),
    search: async (api, input) => {
      const query = String(input?.query || '').trim();
      if (!query) return { ok: false, error: 'query required' };
      const limit = Math.min(Math.max(Number(input?.limit) || 5, 1), 20);
      // Locale is caller-driven (defaults US English) — a gateway cannot read
      // knowledge, so pinning it here would make results uneditable.
      const lang = /^[a-z]{2}(-[A-Z]{2})?$/.test(String(input?.lang || '')) ? input.lang : 'en-US';
      const country = /^[A-Z]{2}$/.test(String(input?.country || '')) ? input.country : 'US';
      const url = `${BASE}?q=${encodeURIComponent(query)}&hl=${lang}&gl=${country}&ceid=${country}:${lang.split('-')[0]}`;
      let r;
      try {
        r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; nyyon-digest)' } });
      } catch (e) {
        return { ok: false, error: `fetch failed: ${String(e?.message || e).slice(0, 120)}` };
      }
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      const xml = await r.text();
      const results = [];
      for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const item = m[1];
        const title = text(item, 'title');
        const link = text(item, 'link');
        if (!title || !link) continue;
        results.push({
          title,
          url: link,
          source: text(item, 'source') || null,
          published_at: text(item, 'pubDate') || null,
        });
        if (results.length >= limit) break;
      }
      return { ok: true, query, results };
    },
  },
};
