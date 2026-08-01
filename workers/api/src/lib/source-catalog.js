// The awareness feed's starting material.
//
// TWO MECHANISMS, and the split is the whole design:
//
//   1. CATALOG — a hand-checked list of publisher feeds. Every URL in here was
//      fetched and parsed before it shipped. This is deliberately NOT
//      generated: asked for "RSS feeds for X", a model returns plausible URLs
//      that 404, and a proposed source that silently fetches nothing is worse
//      than no proposal, because the operator believes they are being watched.
//      (Checking 20 obvious candidates by hand, 6 were dead or redirected.)
//
//   2. KEYWORD FEEDS — a Google News search feed built from the operator's own
//      words. This is what makes the module work for an industry no catalog
//      could anticipate: "commercial plumbing" returns a live feed the same
//      way "AI consulting" does. The URL shape is fixed and known-good, so the
//      only thing the model contributes is the QUERY — words, not URLs.
//
// So the model's job at setup is narrow and safe: pick catalog entries that fit
// this operator, and propose search terms. It never invents an endpoint.
//
// Adding to the catalog: fetch the URL, confirm it parses, then add it. An
// entry that stops working should be removed, not left to fail quietly.

// Verified live before shipping. `tags` is what the picker matches against the
// operator's profile; `weight` nudges the default selection for a generalist.
export const SOURCE_CATALOG = [
  // ── technology + industry news ────────────────────────────────────────────
  { url: 'https://techcrunch.com/feed/', name: 'TechCrunch', category: 'tech',
    tags: ['startups', 'funding', 'technology', 'saas'], weight: 3 },
  { url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge', category: 'tech',
    tags: ['technology', 'consumer', 'product'], weight: 2 },
  { url: 'https://hnrss.org/frontpage', name: 'Hacker News', category: 'tech',
    tags: ['engineering', 'startups', 'developer', 'technology'], weight: 3 },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', name: 'Ars Technica', category: 'tech',
    tags: ['technology', 'security', 'policy'], weight: 2 },
  { url: 'https://www.wired.com/feed/rss', name: 'Wired', category: 'tech',
    tags: ['technology', 'culture', 'business'], weight: 2 },

  // ── AI ────────────────────────────────────────────────────────────────────
  { url: 'https://openai.com/news/rss.xml', name: 'OpenAI', category: 'ai',
    tags: ['ai', 'llm', 'research', 'product'], weight: 3 },
  { url: 'https://deepmind.google/blog/rss.xml', name: 'Google DeepMind', category: 'ai',
    tags: ['ai', 'research'], weight: 2 },
  { url: 'https://huggingface.co/blog/feed.xml', name: 'Hugging Face', category: 'ai',
    tags: ['ai', 'open source', 'models', 'developer'], weight: 2 },
  { url: 'https://venturebeat.com/category/ai/feed', name: 'VentureBeat AI', category: 'ai',
    tags: ['ai', 'enterprise', 'business'], weight: 2 },

  // ── business ──────────────────────────────────────────────────────────────
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', name: 'WSJ Markets', category: 'business',
    tags: ['business', 'markets', 'finance', 'economy'], weight: 2 },

  // ── marketing + search ────────────────────────────────────────────────────
  { url: 'https://searchengineland.com/feed', name: 'Search Engine Land', category: 'marketing',
    tags: ['seo', 'search', 'marketing', 'content'], weight: 3 },
  { url: 'https://moz.com/posts/rss/blog', name: 'Moz', category: 'marketing',
    tags: ['seo', 'search', 'content'], weight: 2 },
  { url: 'https://www.socialmediaexaminer.com/feed/', name: 'Social Media Examiner', category: 'marketing',
    tags: ['social media', 'marketing', 'content'], weight: 2 },

  // ── engineering ───────────────────────────────────────────────────────────
  { url: 'https://stackoverflow.blog/feed/', name: 'Stack Overflow Blog', category: 'engineering',
    tags: ['engineering', 'developer', 'software'], weight: 2 },
  { url: 'https://github.blog/feed/', name: 'GitHub Blog', category: 'engineering',
    tags: ['engineering', 'developer', 'open source'], weight: 2 },
  { url: 'https://martinfowler.com/feed.atom', name: 'Martin Fowler', category: 'engineering',
    tags: ['engineering', 'architecture', 'software'], weight: 1 },
];

// A Google News search feed for arbitrary words. This is the escape hatch from
// the catalog's limits: whatever the operator actually does, their terms
// become a live feed. Quoted phrases are kept quoted so "commercial plumbing"
// does not match every article containing "commercial".
export function keywordFeedUrl(query, { lang = 'en-US', country = 'US' } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${lang}&gl=${country}&ceid=${country}:${lang.split('-')[0]}`;
}

// Name a keyword source for the operator, not for the machine: they should see
// "News · commercial plumbing", never a search URL.
export const keywordFeedName = (query) => `News · ${String(query || '').trim()}`;

// Score the catalog against whatever the operator's profile says. Pure string
// overlap on tags and category, deliberately dumb: the model does the real
// judging at setup, this is the fallback that still returns something sensible
// when there is no model call to make (or it fails).
export function suggestFromCatalog(profileText, { limit = 6 } = {}) {
  const hay = String(profileText || '').toLowerCase();
  const scored = SOURCE_CATALOG.map((s) => {
    let score = s.weight;
    for (const t of s.tags) if (hay.includes(t)) score += 4;
    if (hay.includes(s.category)) score += 2;
    return { ...s, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
