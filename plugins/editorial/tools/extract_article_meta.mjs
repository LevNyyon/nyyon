// Editorial plugin — extract_article_meta. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api,
// callGateway → api.gateway, shared code in the pack's parallel lib (same
// function names, api first). stripHtml/hostOf are inlined per the contract.

import { loadLinkExtractPrompt } from './hot-takes.mjs';

// Crude tag-strip so a pasted page is cheap + safe to hand the model. Callers
// that already fetched clean text (fetch_web_page) pass through untouched.
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

export const def = {
  name: 'extract_article_meta',
  description: 'Read an already-fetched article page and pull out its title, publication, plain-language summary, why-it-matters and publish date. Use after fetching a pasted URL, to turn it into a topic card.',
  input_schema: {
    type: 'object',
    properties: {
      url:  { type: 'string' },
      text: { type: 'string', description: 'the page text (HTML is stripped if you pass markup)' },
    },
    required: ['url'],
  },
};

export async function run(api, input) {
  const url = String(input.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { error: 'url must be http(s)' };
  // `content` is what the shared page-fetch step emits; `text` is the
  // direct-call name. Same thing.
  const text = stripHtml(input.text ?? input.content ?? '').slice(0, 8000);
  const host = hostOf(url);

  let meta = {};
  if (text) {
    const system = await loadLinkExtractPrompt(api);
    meta = await api.gateway('llm', 'json', {
      system,
      prompt: `URL: ${url}\n\nPAGE TEXT:\n${text}`,
      max_tokens: 700,
    }) || {};
  }
  const publishedAt = meta.published_at_iso ? (Date.parse(meta.published_at_iso) || null) : null;
  // The threading keys (origin/origin_ref/source_url/published_at) are what
  // the pinning step consumes — a page that extracts to nothing still pins
  // as a usable card off the URL alone.
  return {
    title: meta.title || host,
    source_name: meta.source_name || host,
    summary: meta.summary || null,
    why_it_matters: meta.why_it_matters || null,
    published_at_iso: meta.published_at_iso || null,
    published_at: publishedAt,
    source_url: url,
    origin: 'link',
    origin_ref: url,
  };
}
