// Editorial plugin — add_hottake_link. Surface entry point for the old
// POST /api/hot-takes/add-link route, which ran the hottake-add-link workflow
// (fetch_web_page → extract_article_meta → pin_hottake_topic). Same three
// steps here in one tool: fetch the page text through the web gateway, extract
// its meta with the link-extraction prompt, pin the result as a Selected
// topic. A page that extracts to nothing still pins as a usable card off the
// URL alone — idempotent by origin_ref (the URL).

import { fetchArticleText } from './heartbeat.mjs';
import { loadLinkExtractPrompt, pinTopic } from './hot-takes.mjs';

export const def = {
  name: 'add_hottake_link',
  description: 'Turn a pasted article URL into a Selected Topic: fetch the page, extract title/publication/summary/why-it-matters, and pin it as a package at status "topic". Idempotent — the same link never pins twice.',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'full http(s) link' } },
    required: ['url'],
  },
};

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export async function run(api, input) {
  const url = String(input.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { error: 'url must be http(s)' };

  const text = await fetchArticleText(api, url, { maxChars: 8000 });
  let meta = {};
  if (text) {
    const system = await loadLinkExtractPrompt(api);
    meta = await api.gateway('llm', 'json', {
      system,
      prompt: `URL: ${url}\n\nPAGE TEXT:\n${text}`,
      max_tokens: 700,
    }).catch(() => ({})) || {};
  }
  const host = hostOf(url);
  const publishedAt = meta.published_at_iso ? (Date.parse(meta.published_at_iso) || null) : null;
  const pkg = await pinTopic(api, {
    origin: 'link',
    origin_ref: url,
    title: meta.title || host || url,
    summary: meta.summary ?? null,
    why_it_matters: meta.why_it_matters ?? null,
    source_name: meta.source_name || host || null,
    source_url: url,
    published_at: publishedAt,
  }, input.actor || 'operator');
  if (!pkg) return { error: 'could not read that link' };
  return { package: pkg };
}
