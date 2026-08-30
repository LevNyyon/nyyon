// article-text.js — fetch a URL and reduce it to readable article text.
//
// Extracted VERBATIM from lib/heartbeat.js when the heartbeat engine moved
// into the editorial plugin: the host web-read tool (tools/core.js
// read_web_page) still needs this HTML-to-text extractor, and the plugin
// reaches the network only through the web gateway, so the host keeps its own
// copy of the one pure function it consumes.

import { fetchText as webFetchText } from './web-gateway.js';
import { decodeNumericEntities } from './util.js';

// Strip tags/CDATA and decode entities — the same decoder the RSS parser used.
function decode(s = '') {
  return decodeNumericEntities(
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')                 // strip any inner HTML
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' '),
  )
    // &amp; LAST: a feed that double-escapes writes &amp;#039;, and undoing
    // the ampersand first would turn it into a live &#039; that the numeric
    // pass then eats — silently changing the author's text.
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

// ─── full article text (so Nyo reacts to content, not just titles) ──────────
// Fetch a URL, follow redirects (Google News links bounce to the publisher),
// strip to readable text, cap length. Crude but enough for the LLM to react to
// the actual argument. Returns '' on failure (caller falls back to summary).
export async function fetchArticleText(env, url, { maxChars = 8000 } = {}) {
  try {
    const r = await webFetchText(env, {
      url, timeout_ms: 12000, max_bytes: Infinity,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; heartbeat-rss/1.0)' },
    });
    if (!r.ok) return '';
    const ct = r.content_type || '';
    if (!ct.includes('html') && !ct.includes('text')) return '';
    let html = r.text;
    // drop non-content blocks entirely
    html = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
    // prefer <article> / <main> body if present
    const main = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i);
    const scope = main ? main[0] : html;
    const text = decode(scope);
    // if extraction is junky/tiny, treat as failure
    return text.length > 200 ? text.slice(0, maxChars) : '';
  } catch {
    return '';
  }
}
