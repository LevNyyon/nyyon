// Editorial plugin — heartbeat (lib). Ported from workers/api/src/lib/heartbeat.js
// under the plugin capability contract: every function that needs the outside
// world takes `api` as its FIRST argument (api.db / api.gateway / api.knowledge /
// api.saveKnowledge / api.log). This file imports NOTHING.
//
// OSINT v2, the Command Center's awareness layer. Senses the outside world from
// authoritative sources (company-blog RSS + Google News RSS topic queries),
// LLM-scores each item for relevance + content value, and maintains a standing
// "industry pulse" that Nyo can pull into any conversation and the Digest
// presents as situational awareness.
//
//   runHeartbeat(api)      → ingest all sources + score new signals
//   synthesizePulse(api)   → rebuild the plugin-editorial-industry-pulse doc
//   topSignals(api, opts)  → query scored signals (for Digest / Nyo / Brain)
//
// External reach ONLY through declared gateways: web(text) for feeds/articles,
// llm(text, json) for scoring/synthesis.

// ─── inlined utils (lib files import nothing) ───────────────────────────────
const uid = () => crypto.randomUUID();
const now = () => Date.now();

// Numeric HTML character references, decimal and hex, decoded by VALUE so every
// padding (&#39; &#039; &#x27;) is covered at once. fromCodePoint, not
// fromCharCode: the latter truncates above U+FFFF. Unparseable refs stay as-is.
function decodeNumericEntities(s = '') {
  return String(s)
    .replace(/&#(\d+);/g, (m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    });
}

// Universal typography guard: NO en-dashes or em-dashes anywhere in any output.
function stripDashes(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\s*—\s*/g, ', ')  // em-dash -> comma + space
    .replace(/\s*–\s*/g, '-');  // en-dash -> hyphen
}

function clampInt(n) { const v = parseInt(n, 10); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null; }

// ─── knowledge slugs (re-slugged to the plugin namespace) ───────────────────
export const GATES_SLUG = 'plugin-editorial-heartbeat-priorities';
const PULSE_SLUG = 'plugin-editorial-industry-pulse';
const PULSE_PROMPT_SLUG = 'plugin-editorial-heartbeat-pulse-prompt';
const TASTE_SLUG = 'plugin-editorial-editorial-taste';
const BRAND_VOICE_SLUG = 'brand-voice'; // HOST doc — declared read in requires.knowledge

// ─── seed sources ───────────────────────────────────────────────────────────
// Company blogs (primary sources) + Google News topic queries (real outlets,
// aggregated, structured). Dead feeds just log last_status='error' and skip.
const GNEWS = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// The same builder, exported — writeHeartbeatSource turns a gnews `query` into
// this URL at save time, and the first-run scout has to FETCH the built URL to
// prove a topic query actually returns items before it offers it. One
// definition, so a proposal is validated against the exact URL that gets saved.
export function gnewsUrl(query) { return GNEWS(String(query || '')); }

// Neutral general-tech placeholder watchlist. It exists so a fresh install
// has SOMETHING flowing on day one; the Hot Takes first-run scout replaces it
// with sources from the operator's own industry, and the Sources tab edits it
// any time.
export const DEFAULT_SOURCES = [
  // company / lab blogs
  { kind: 'rss', name: 'OpenAI', url: 'https://openai.com/news/rss.xml', theme: 'models' },
  { kind: 'rss', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', theme: 'models' },
  { kind: 'rss', name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', theme: 'models' },
  { kind: 'rss', name: 'Microsoft Research', url: 'https://www.microsoft.com/en-us/research/feed/', theme: 'models' },
  // general tech press
  { kind: 'rss', name: 'The Verge · AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', theme: 'general' },
  { kind: 'rss', name: 'TechCrunch · AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', theme: 'general' },
  { kind: 'rss', name: 'VentureBeat · AI', url: 'https://venturebeat.com/category/ai/feed/', theme: 'general' },
  // Google News topic queries
  { kind: 'gnews', name: 'Topic · AI news', url: GNEWS('"artificial intelligence" when:7d'), theme: 'general' },
  { kind: 'gnews', name: 'Topic · AI agents', url: GNEWS('"AI agents" when:7d'), theme: 'technology' },
];

export async function seedSourcesIfEmpty(api) {
  const r = await api.db.prepare('SELECT COUNT(*) AS n FROM plugin_editorial_osint_sources').first();
  if ((r?.n || 0) > 0) return { seeded: 0 };
  let n = 0;
  for (const s of DEFAULT_SOURCES) {
    await api.db.prepare(
      `INSERT INTO plugin_editorial_osint_sources (id, kind, name, url, theme, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).bind(uid(), s.kind, s.name, s.url, s.theme, now()).run();
    n++;
  }
  return { seeded: n };
}

// ─── feed parsing (RSS + Atom, regex-based — workerd has no DOMParser) ──────
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
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
}
function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : null;
}

export function parseFeed(xml) {
  if (!xml) return [];
  const out = [];
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s\S]*?<\/entry>/gi : /<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = decode(tag(b, 'title') || '');
    let link = null;
    if (isAtom) {
      // prefer rel="alternate" or first <link href="...">
      const alt = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
               || b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = alt ? alt[1] : null;
    } else {
      link = decode(tag(b, 'link') || '');
      // Google News wraps the real URL; the <link> text is the redirector — fine, still unique.
    }
    const summaryRaw = tag(b, 'description') || tag(b, 'summary') || tag(b, 'content') || '';
    const summary = decode(summaryRaw).slice(0, 600);
    const dateStr = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || null;
    if (!title || !link) continue;
    out.push({ title, url: link.trim(), summary, published_at: parseDate(dateStr) });
  }
  return out;
}

async function fetchSource(api, source) {
  // max_bytes: Infinity keeps the pre-gateway uncapped read; feeds are small.
  const r = await api.gateway('web', 'text', {
    url: source.url, timeout_ms: 12000, max_bytes: Infinity,
    headers: { 'user-agent': 'heartbeat-rss/1.0' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseFeed(r.text);
}

// ─── full article text (so Nyo reacts to content, not just titles) ──────────
// Fetch a URL, follow redirects (Google News links bounce to the publisher),
// strip to readable text, cap length. Crude but enough for the LLM to react to
// the actual argument. Returns '' on failure (caller falls back to summary).
export async function fetchArticleText(api, url, { maxChars = 8000 } = {}) {
  try {
    const r = await api.gateway('web', 'text', {
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

// ─── sources CRUD (the OSINT module's Sources tab + Nyo tools) ──────────────
export async function listHeartbeatSources(api) {
  const r = await api.db.prepare('SELECT * FROM plugin_editorial_osint_sources ORDER BY kind, name').all();
  return r.results || [];
}

export async function writeHeartbeatSource(api, body = {}) {
  const id = body.id || uid();
  const existing = body.id
    ? await api.db.prepare('SELECT * FROM plugin_editorial_osint_sources WHERE id = ?').bind(body.id).first()
    : null;
  const kind = body.kind ?? existing?.kind ?? 'rss';
  // gnews sources can be authored by plain query text — we build the feed URL.
  const url = body.url ?? (body.query && kind === 'gnews' ? GNEWS(String(body.query)) : existing?.url);
  const name = body.name ?? existing?.name;
  if (!name || !url) throw new Error('name and url (or a gnews query) required');
  if (!/^https?:\/\//i.test(String(url))) throw new Error('url must be http(s)');
  if (!['rss', 'gnews'].includes(kind)) throw new Error("kind must be 'rss' or 'gnews'");
  if (existing) {
    await api.db.prepare(
      'UPDATE plugin_editorial_osint_sources SET kind=?, name=?, url=?, theme=?, enabled=? WHERE id=?',
    ).bind(kind, name, url, body.theme ?? existing.theme, body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled, id).run();
  } else {
    await api.db.prepare(
      'INSERT INTO plugin_editorial_osint_sources (id, kind, name, url, theme, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, kind, name, url, body.theme || 'general', body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1, now()).run();
  }
  await api.log(existing ? 'osint_source_updated' : 'osint_source_added', { id, name, kind, enabled: body.enabled });
  return api.db.prepare('SELECT * FROM plugin_editorial_osint_sources WHERE id = ?').bind(id).first();
}

export async function deleteHeartbeatSource(api, id) {
  const row = await api.db.prepare('SELECT name FROM plugin_editorial_osint_sources WHERE id = ?').bind(id).first();
  await api.db.prepare('DELETE FROM plugin_editorial_osint_sources WHERE id = ?').bind(id).run();
  await api.log('osint_source_deleted', { id, name: row?.name || null });
  return { ok: true, id };
}

// ─── score gates (knowledge-backed) ──────────────────────────────────────────
// The plugin-editorial-heartbeat-priorities doc claims "content_score>=70
// reaches the digest" — these gates make that true: a fenced ```json block in
// the doc overrides the coded defaults, so editing the doc actually changes
// what flows through.
const GATE_DEFAULTS = Object.freeze({
  digest_min_content: 70,   // pullHeartbeat: signals entering the morning brief
  topics_min_content: 62,   // hot-topic synthesis input floor
  enrich_min_relevance: 60, // which signals get the full-article re-score
});
const GATES_BLOCK_RE = /```json\s*[\s\S]*?```/;

export async function heartbeatGates(api) {
  try {
    const doc = await api.knowledge(GATES_SLUG);
    const m = String(doc?.body || '').match(/```json\s*([\s\S]*?)```/);
    const src = m ? JSON.parse(m[1]) : {};
    const out = {};
    for (const [k, dflt] of Object.entries(GATE_DEFAULTS)) {
      const n = Number(src[k]);
      out[k] = Number.isFinite(n) && n >= 0 ? n : dflt;
    }
    return out;
  } catch { return { ...GATE_DEFAULTS }; }
}

// Edit the gates in place, from the UI, without touching code.
//
// The thresholds are NOT constants here — they live in the
// plugin-editorial-heartbeat-priorities note as a fenced ```json block that
// heartbeatGates() reads on every run. This rewrites ONLY that block and
// leaves the operator's surrounding prose intact, so the note stays a human
// document that happens to carry machine-readable numbers. If the block is
// missing it is appended rather than replacing the doc.
export async function patchHeartbeatGates(api, patch = {}) {
  const before = await heartbeatGates(api);
  const after = { ...before };
  for (const k of Object.keys(GATE_DEFAULTS)) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') continue;
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      throw new Error(`${k} must be a number between 0 and 100`);
    }
    after[k] = Math.round(n);
  }

  const doc = await api.knowledge(GATES_SLUG).catch(() => null);
  const body = String(doc?.body || '');
  const block = '```json\n' + JSON.stringify(after, null, 2) + '\n```';
  const nextBody = GATES_BLOCK_RE.test(body)
    ? body.replace(GATES_BLOCK_RE, block)
    : (body.trim() ? `${body.trim()}\n\n${block}\n` : `${block}\n`);

  await api.saveKnowledge(GATES_SLUG, {
    title: doc?.title || 'Heartbeat priorities',
    body: nextBody,
  });
  await api.log('heartbeat_gates_updated', { before, after });
  return after;
}

// ─── ingest ─────────────────────────────────────────────────────────────────
// Pull all enabled sources, insert new (unseen-URL) items as status='new'.
export async function ingestHeartbeat(api) {
  await seedSourcesIfEmpty(api);
  const sources = (await api.db.prepare('SELECT * FROM plugin_editorial_osint_sources WHERE enabled = 1').all()).results || [];
  let inserted = 0;
  const perSource = [];
  for (const s of sources) {
    try {
      const entries = await fetchSource(api, s);
      let added = 0;
      for (const e of entries.slice(0, 25)) {
        const exists = await api.db.prepare('SELECT 1 FROM plugin_editorial_osint_signals WHERE url = ? LIMIT 1').bind(e.url).first();
        if (exists) continue;
        await api.db.prepare(
          `INSERT OR IGNORE INTO plugin_editorial_osint_signals (id, source_id, source_name, theme, title, url, summary, published_at, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
        ).bind(uid(), s.id, s.name, s.theme, e.title, e.url, e.summary, e.published_at, now()).run();
        added++; inserted++;
      }
      await api.db.prepare(`UPDATE plugin_editorial_osint_sources SET last_fetched_at=?, last_status='ok', last_error=NULL WHERE id=?`)
        .bind(now(), s.id).run();
      perSource.push({ source: s.name, added });
    } catch (e) {
      await api.db.prepare(`UPDATE plugin_editorial_osint_sources SET last_fetched_at=?, last_status='error', last_error=? WHERE id=?`)
        .bind(now(), String(e?.message || e).slice(0, 200), s.id).run();
      perSource.push({ source: s.name, error: String(e?.message || e) });
    }
  }
  try { await api.log('osint_signals_ingested', { inserted, sources: perSource.length }); } catch { /* the bus must never fail the ingest */ }
  return { inserted, perSource };
}

// ─── score (the noise killer) ───────────────────────────────────────────────
// The scoring RUBRIC (what counts as important) lives in an editable knowledge
// doc — plugin-editorial-heartbeat-priorities — NOT hardcoded here. The
// operator can read and change it any time; the scorer reads it on every run.
// This block is only the fallback used if that doc is ever missing.
const SCORE_RULES_FALLBACK = `The operator's world: major product and model launches, real shifts in their industry, tools that change how their customers work, competitor moves, sharp industry debates. Noise (score low): generic listicles, off-topic news, vague PR, consumer gadgets. content_score>=70 reaches the digest. Be harsh.`;

function buildScoreSystem(rules) {
  return `You score industry signals for the operator's company. Use the operator's prioritization rules below to decide what matters.

=== PRIORITIZATION RULES (operator-editable) ===
${rules}
=== END RULES ===

For each item, judge:
- relevance (0-100): does it matter to the operator's world per the rules above?
- content_score (0-100): could the operator turn it into a strong blog or social post? (timely + opinionated + on-brand = high)
- formats: which of "blog","social" it could become (array; can be both or empty)
- suggested_angle: one sentence — the angle the operator's company would take (empty if not content-worthy)
- why: one short line on the call

Return ONLY: { "scores": [ { "i": <index>, "relevance": N, "content_score": N, "formats": [..], "suggested_angle": "...", "why": "..." }, ... ] }`;
}

export async function scoreNewSignals(api, { limit = 30 } = {}) {
  // Read the editable rubric from knowledge each run (transparent + tunable).
  const rulesDoc = await api.knowledge(GATES_SLUG).catch(() => null);
  const SCORE_SYSTEM = buildScoreSystem(rulesDoc?.body || SCORE_RULES_FALLBACK);
  const rows = (await api.db.prepare(
    `SELECT id, title, summary, source_name, theme FROM plugin_editorial_osint_signals WHERE status='new' ORDER BY created_at DESC LIMIT ?`
  ).bind(limit).all()).results || [];
  if (!rows.length) return { scored: 0 };

  const list = rows.map((r, i) => `[${i}] (${r.source_name} · ${r.theme}) ${r.title}${r.summary ? ` — ${r.summary.slice(0, 180)}` : ''}`).join('\n');
  const out = await api.gateway('llm', 'json', {
    system: SCORE_SYSTEM,
    prompt: `Score these ${rows.length} items.\n\n${list}\n\nReturn the JSON.`,
  });
  const scores = Array.isArray(out?.scores) ? out.scores : [];
  let scored = 0;
  for (const s of scores) {
    const row = rows[s.i];
    if (!row) continue;
    await api.db.prepare(
      `UPDATE plugin_editorial_osint_signals SET relevance=?, content_score=?, formats=?, suggested_angle=?, why=?, status='scored' WHERE id=?`
    ).bind(
      clampInt(s.relevance), clampInt(s.content_score),
      Array.isArray(s.formats) ? s.formats.join(',') : null,
      (s.suggested_angle || '').slice(0, 300) || null,
      (s.why || '').slice(0, 300) || null,
      row.id,
    ).run();
    scored++;
  }
  // Any rows the model skipped: mark scored with relevance 0 so we don't re-score forever.
  for (let i = 0; i < rows.length; i++) {
    if (!scores.find((s) => s.i === i)) {
      await api.db.prepare(`UPDATE plugin_editorial_osint_signals SET status='scored', relevance=COALESCE(relevance,0) WHERE id=?`).bind(rows[i].id).run();
    }
  }
  try { await api.log('osint_signals_scored', { scored, considered: rows.length }); } catch { /* */ }
  return { scored };
}

// ─── enrich (read the actual article + re-score on real content) ────────────
// For signals that PASSED the title gate (relevance high) but haven't been read
// yet, fetch the full article, cache the text, and re-score content_score +
// suggested_angle from what the piece ACTUALLY says. Bounded per run.
// The enrich pass re-judges (and OVERWRITES) content_score/suggested_angle,
// so it must read the same operator-editable rubric the first-pass scorer
// uses — otherwise heartbeat-priorities edits get discarded at this stage.
async function buildEnrichSystem(api) {
  const rulesDoc = await api.knowledge(GATES_SLUG).catch(() => null);
  return `${ENRICH_SYSTEM}

=== PRIORITIZATION RULES (operator-editable) ===
${rulesDoc?.body || SCORE_RULES_FALLBACK}
=== END RULES ===`;
}
const ENRICH_SYSTEM = `You are scoring an industry item for the operator's company — but now you have the FULL article text, not just the title. Re-judge based on what the piece actually argues.

Return ONLY JSON:
{ "content_score": 0-100, "formats": ["blog"|"social"], "suggested_angle": "<the specific, content-grounded angle the operator's company would take — reference an actual point the article makes>", "takeaway": "<1-2 sentence summary of what the article actually says>" }`;

export async function enrichSignals(api, { limit = 12, minRelevance = null } = {}) {
  if (minRelevance == null) minRelevance = (await heartbeatGates(api)).enrich_min_relevance;
  // Google News links are redirector/consent-wrapped — they don't fetch to a
  // real article. Skip them for the content-read path; they keep their
  // title-level score. Direct publisher feeds (OpenAI, Verge, TechCrunch, …)
  // have real URLs and fetch cleanly — those are what we read.
  const rows = (await api.db.prepare(
    `SELECT id, title, url, summary FROM plugin_editorial_osint_signals
      WHERE status='scored' AND content_fetched_at IS NULL AND relevance >= ?
        AND url NOT LIKE '%news.google.com%'
      ORDER BY relevance DESC, content_score DESC LIMIT ?`
  ).bind(minRelevance, limit).all()).results || [];
  let enriched = 0;
  for (const row of rows) {
    const text = await fetchArticleText(api, row.url);
    // mark fetched regardless (don't retry forever); store text if we got it
    if (!text) {
      await api.db.prepare(`UPDATE plugin_editorial_osint_signals SET content_fetched_at=? WHERE id=?`).bind(now(), row.id).run();
      continue;
    }
    try {
      const out = await api.gateway('llm', 'json', {
        system: await buildEnrichSystem(api),
        prompt: `Title: ${row.title}\n\nFull article text:\n${text}\n\nRe-score from the real content. Return JSON.`,
      });
      await api.db.prepare(
        `UPDATE plugin_editorial_osint_signals SET full_text=?, content_fetched_at=?, content_score=COALESCE(?,content_score),
           formats=COALESCE(?,formats), suggested_angle=COALESCE(?,suggested_angle), summary=COALESCE(?,summary) WHERE id=?`
      ).bind(
        text.slice(0, 8000), now(),
        clampInt(out?.content_score),
        Array.isArray(out?.formats) ? out.formats.join(',') : null,
        (out?.suggested_angle || '').slice(0, 400) || null,
        (out?.takeaway || '').slice(0, 400) || null,   // upgrade summary to a real takeaway
        row.id,
      ).run();
      enriched++;
    } catch {
      await api.db.prepare(`UPDATE plugin_editorial_osint_signals SET full_text=?, content_fetched_at=? WHERE id=?`).bind(text.slice(0, 8000), now(), row.id).run();
    }
  }
  try { await api.log('osint_signals_enriched', { enriched, considered: rows.length }); } catch { /* */ }
  return { enriched, considered: rows.length };
}

// Read one signal's full article on demand (for Nyo in chat). Caches it.
export async function readSignalContent(api, signalId) {
  const sig = await api.db.prepare('SELECT * FROM plugin_editorial_osint_signals WHERE id=?').bind(signalId).first();
  if (!sig) return null;
  if (sig.full_text) return sig;
  const text = await fetchArticleText(api, sig.url);
  if (text) {
    await api.db.prepare(`UPDATE plugin_editorial_osint_signals SET full_text=?, content_fetched_at=? WHERE id=?`).bind(text.slice(0, 8000), now(), signalId).run();
    sig.full_text = text.slice(0, 8000);
  }
  return sig;
}

// ─── orchestration ──────────────────────────────────────────────────────────
export async function runHeartbeat(api, { actor = 'heartbeat-cron' } = {}) {
  const ingest = await ingestHeartbeat(api);
  // Score in a couple of batches so a big first run doesn't get truncated.
  let scoredTotal = 0;
  for (let i = 0; i < 3; i++) {
    const { scored } = await scoreNewSignals(api, { limit: 30 });
    scoredTotal += scored;
    if (!scored) break;
  }
  // Read the survivors and re-score on real content.
  let enriched = 0;
  try { enriched = (await enrichSignals(api, { limit: 12 })).enriched; } catch { /* best effort */ }
  let pulse = null;
  try { pulse = await synthesizePulse(api); } catch { /* best effort */ }
  // Cluster the strongest signals into digest-ready hot topics (the value layer).
  let topics = 0;
  try { topics = (await synthesizeHotTopics(api)).count || 0; } catch { /* best effort */ }
  return { ok: true, inserted: ingest.inserted, scored: scoredTotal, enriched, per_source: ingest.perSource, pulse_updated: !!pulse, topics };
}

// ─── query helpers ──────────────────────────────────────────────────────────
// Top recent scored signals — used by Digest, Nyo, Sunday Brain.
// Build a bound LIKE term for free-text search. Escapes the SQL wildcards so an
// operator typing "50%" or "a_b" searches for those literal characters instead
// of matching everything. The term is always BOUND, never interpolated.
//
// The escape character is '@', NOT the conventional backslash: D1 rejects
// `ESCAPE '\'` outright ("unrecognized token" — its parser will not take a lone
// backslash string literal), while `ESCAPE '@'` works and escapes correctly.
// Verified against the live D1. Keep this in sync with LIKE_ESC below.
const LIKE_ESC = "@";
function likeTerm(q) {
  return '%' + String(q).trim().replace(/[@%_]/g, (c) => LIKE_ESC + c) + '%';
}

export async function topSignals(api, { days = 7, minContent = 55, limit = 12, q = '' } = {}) {
  const since = now() - days * 86400000;
  const term = String(q || '').trim();
  const where = [
    `status IN ('scored','surfaced','actioned')`,
    `content_score >= ?`,
    `(published_at IS NULL OR published_at > ?)`,
    `created_at > ?`,
  ];
  const binds = [minContent, since, since];
  if (term) {
    where.push(`(title LIKE ? ESCAPE '@' OR summary LIKE ? ESCAPE '@' OR suggested_angle LIKE ? ESCAPE '@')`);
    const t = likeTerm(term);
    binds.push(t, t, t);
  }
  const r = await api.db.prepare(
    `SELECT * FROM plugin_editorial_osint_signals
      WHERE ${where.join(' AND ')}
      ORDER BY content_score DESC, created_at DESC LIMIT ?`
  ).bind(...binds, limit).all();
  return r.results || [];
}

// ─── synthesis — the standing "industry pulse" Nyo queries ──────────────────
const PULSE_SYSTEM = `You maintain the operator's INDUSTRY PULSE — a tight situational-awareness brief on what's happening in their industry right now.

Given the top scored signals from the last week, write a concise markdown brief:

## The pulse (this week)
3-6 bullets — the genuinely important moves (launches, industry shifts, competitor moves). Each bullet: what happened + why it matters to the operator, one line.

## Worth writing about
2-4 bullets — the strongest blog/social angles, each as "<angle> — <format>".

## Watch
0-3 bullets — slower-burning things to keep an eye on.

Be specific and opinionated. Skip noise. If signals are thin, say so honestly.`;

export async function synthesizePulse(api) {
  const signals = await topSignals(api, { days: 7, minContent: 45, limit: 20 });
  if (!signals.length) return null;
  const list = signals.map((s) => `- (${s.source_name} · score ${s.content_score}) ${s.title}${s.suggested_angle ? ` [angle: ${s.suggested_angle}]` : ''}`).join('\n');
  let pulseSystem = PULSE_SYSTEM;
  try {
    const doc = await api.knowledge(PULSE_PROMPT_SLUG);
    if (doc?.body && String(doc.body).trim().length > 80) pulseSystem = String(doc.body);
  } catch { /* coded frame */ }
  const md = await api.gateway('llm', 'text', { system: pulseSystem, prompt: `Top signals this week:\n\n${list}\n\nWrite the pulse brief.`, model: 'gpt-4o-mini' });
  await api.saveKnowledge(PULSE_SLUG, {
    title: 'Industry Pulse — live awareness',
    body: `_Auto-refreshed by the heartbeat. What's happening in the operator's industry right now, and what to do about it._\n\n${md.trim()}`,
  });
  return md.trim();
}

export async function readPulse(api) {
  const doc = await api.knowledge(PULSE_SLUG).catch(() => null);
  return doc?.body || null;
}

// The operator's learned editorial taste (maintained by the aeo-taste lib as
// its own plugin doc). Read-only here — it seasons the hot-topic synthesis.
async function readTasteProfile(api) {
  const doc = await api.knowledge(TASTE_SLUG).catch(() => null);
  return doc?.body || null;
}

// ─── hot topics — the value layer ────────────────────────────────────────────
// Scoring + enrichment grade individual signals. This CLUSTERS the strongest
// ones into a handful of sharp, opinionated "hot topics with the company's
// angle" at blog-grade quality, stored as discrete rows so the Digest can
// quote each one.
// Runs on the STRONG model (omit model => opus) + the editorial voice/taste —
// that is what makes the angles land like the blog titles instead of generic
// per-article blurbs.
function topicsSystem(voice) {
  return `You are a sharp, fearless industry analyst surfacing HOT TAKES for an audience (the operator and their company) that has seen everything. From this week's signals, find the genuinely INTERESTING takes: the ones worth arguing about.

A HOT TAKE is a bold, specific, debatable OPINION that takes a side and makes a smart person stop and want to argue. It NAMES the thing (a company, a claim, a consensus). It says what most people will not. It is falsifiable or genuinely provocative.
KILL anything that: hedges ("it depends"), gives a tip or how-to, reads like agency thought-leadership, just restates the news, or could be published by any brand without risk. If it is safe, cut it. Do NOT turn every take into a pitch for "owning the system" or "building infrastructure" — that is the weak move.

Energy to match (NOT your subjects, just the spice level):
- "Most AI agents shipping today are cron jobs in a trench coat."
- "Perplexity raising 200M for a browser is a confession it cannot win search."
- "AEO is a rebrand for the consultants who fumbled SEO."

Work SEVERAL angles so the set is varied, not five versions of one idea:
- CONTRARIAN: argue the opposite of what everyone agrees on.
- PREDICTION: a falsifiable call on what happens next, and who specifically loses.
- EMPEROR: call out the hype or theater the industry pretends not to see.
- UNSAID: the uncomfortable truth insiders know but will not post.
- POWER MOVE: decode what a specific company's move REALLY reveals (fear, retreat, land-grab) versus its press-release framing.

Generate candidates across those angles, then keep ONLY the 5-6 spiciest and most DISTINCT. Each must take a clear side.
${voice ? `\nMatch this house WRITING style (the voice, not the safeness):\n${voice}\n` : ''}
Style: title is ONE sharp declarative sentence. No en-dashes or em-dashes; use commas, colons, plain hyphens. Banned words: revolutionary, game-changing, disruptive, next-gen, cutting-edge, world-class, leverage (verb), synergy, unlock, in today's world.

Return ONLY:
{ "topics": [ {
  "title": "the hot take, one sharp declarative sentence",
  "argument": "2-3 sentences making the case",
  "why_now": "the trigger, one line",
  "counter": "the strongest argument AGAINST it (a real hot take knows its opposition)",
  "format": "blog" | "social" | "both",
  "heat": 0-100,
  "sources": ["<exact signal title it draws on>"]
} ] }`;
}

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function topicId(title) {
  // stable djb2 hash of the normalized title -> recurring topics dedupe across runs
  let h = 5381; const s = normTitle(title);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'otopic_' + h.toString(36);
}
// NOTE: the host lib lazily CREATE TABLE'd osint_topics here. Plugin-scoped SQL
// forbids DDL — plugin_editorial_osint_topics is created from the manifest's
// declared ddl at install time instead, so the lazy ensure step is gone.

// Cluster the top scored+enriched signals into digest-ready hot topics.
export async function synthesizeHotTopics(api, { days = 10, minContent = null, limit = 26 } = {}) {
  if (minContent == null) minContent = (await heartbeatGates(api)).topics_min_content;
  const signals = await topSignals(api, { days, minContent, limit });
  if (signals.length < 3) return { ok: false, reason: 'not enough scored signals', count: 0, topics: [] };

  const brand = (await api.knowledge(BRAND_VOICE_SLUG).catch(() => null))?.body || '';
  const taste = await readTasteProfile(api).catch(() => null);
  const voice = [brand, taste && `## Operator's learned editorial taste\n${taste}`].filter(Boolean).join('\n\n');

  const list = signals.map((s) =>
    `- (${s.source_name} · ${s.theme} · heat ${s.content_score}) ${s.title}` +
    `${s.suggested_angle ? ` [angle: ${s.suggested_angle}]` : ''}` +
    `${s.summary ? ` — ${String(s.summary).slice(0, 200)}` : ''}`).join('\n');

  // Omit `model` => provider default (opus), NOT the cheap scorer model.
  const out = await api.gateway('llm', 'json', {
    system: topicsSystem(voice),
    prompt: `This week's strongest signals (${signals.length}):\n\n${list}\n\nSynthesize the hot topics now. Return the JSON.`,
  });
  const topics = Array.isArray(out?.topics) ? out.topics : [];
  const byTitle = new Map(signals.map((s) => [normTitle(s.title), { title: s.title, url: s.url }]));

  const saved = [];
  const ts = now();
  for (const t of topics) {
    if (!t?.title) continue;
    const title = stripDashes(String(t.title)).slice(0, 200);
    const id = topicId(title);
    const sources = (Array.isArray(t.sources) ? t.sources : [])
      .map((st) => byTitle.get(normTitle(st)) || { title: String(st).slice(0, 200), url: null }).slice(0, 5);
    await api.db.prepare(
      `INSERT OR REPLACE INTO plugin_editorial_osint_topics (id, title, thesis, why_now, angle, format, heat, sources_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT status FROM plugin_editorial_osint_topics WHERE id=?), 'new'), ?)`
    ).bind(
      id, title,
      stripDashes(t.argument || t.thesis || '').slice(0, 800) || null,   // thesis col holds the argument
      stripDashes(t.why_now || '').slice(0, 300) || null,
      stripDashes(t.counter || t.angle || '').slice(0, 600) || null,      // angle col holds the counter
      String(t.format || 'blog').slice(0, 12),
      clampInt(t.heat) ?? 70,
      JSON.stringify(sources), id, ts,
    ).run();
    saved.push({ id, title, argument: t.argument || t.thesis, why_now: t.why_now, counter: t.counter || t.angle, format: t.format, heat: clampInt(t.heat), sources });
  }
  try { await api.log('osint_topics_synthesized', { count: saved.length }); } catch { /* */ }
  return { ok: true, count: saved.length, topics: saved };
}

// Latest hot topics for the Digest / Nyo. Newest synthesis, hottest first.
export async function topHotTopics(api, { limit = 6, days = 3, q = '' } = {}) {
  const since = now() - days * 86400000;
  const term = String(q || '').trim();
  const where = [`status != 'dismissed'`, `created_at > ?`];
  const binds = [since];
  if (term) {
    where.push(`(title LIKE ? ESCAPE '@' OR thesis LIKE ? ESCAPE '@' OR why_now LIKE ? ESCAPE '@')`);
    const t = likeTerm(term);
    binds.push(t, t, t);
  }
  const r = await api.db.prepare(
    `SELECT * FROM plugin_editorial_osint_topics WHERE ${where.join(' AND ')}
       ORDER BY heat DESC, created_at DESC LIMIT ?`
  ).bind(...binds, limit).all();
  return (r.results || []).map((t) => ({ ...t, sources: JSON.parse(t.sources_json || '[]') }));
}

// ─── signal actions (called by the signal_to_* tools) ───────────────────────

// The AEO-question seed a signal implies: pure field selection, no model and no
// writes, so the granular signal→blog chain can hand these straight to the AEO
// question writer. Priority 2 is the "timely" lane (same value signalToBlog has
// always used) and expert_context carries the article's real text so the write
// reacts to what the source SAYS, not just its headline.
export function signalQuestionSeed(sig) {
  if (!sig) return null;
  const question = sig.suggested_angle || sig.title;
  return {
    question,
    priority: 2,
    notes: `From heartbeat signal (${sig.source_name}). Angle: ${sig.suggested_angle || '—'}. Source: ${sig.url}`,
    expert_context: sig.full_text
      ? {
        from_signal: sig.id, source: sig.source_name, source_url: sig.url,
        answers: `Source article ("${sig.title}", ${sig.source_name}):\n\n${sig.full_text.slice(0, 6000)}\n\nThe operator's angle on it: ${sig.suggested_angle || '(take a contrarian, on-brand stance)'}`,
      }
      : null,
  };
}

// Patch one signal's status (actioned once it produced something, dismissed
// when the operator waves it off). Its own export so the chain can close the
// loop without re-running the whole signalToBlog.
export async function patchSignal(api, signalId, { status } = {}) {
  const allowed = ['new', 'scored', 'actioned', 'dismissed'];
  if (!allowed.includes(status)) throw new Error(`patchSignal: status must be one of ${allowed.join('|')}`);
  const sig = await api.db.prepare('SELECT * FROM plugin_editorial_osint_signals WHERE id = ?').bind(signalId).first();
  if (!sig) return null;
  await api.db.prepare('UPDATE plugin_editorial_osint_signals SET status = ? WHERE id = ?').bind(status, signalId).run();
  await api.log('osint_signal_updated', { id: signalId, status });
  return { ...sig, status };
}

// ─── AEO question upsert (inlined from db.js — same table, plugin-namespaced) ─
async function readAeoQuestionRow(api, slug) {
  return api.db.prepare('SELECT * FROM plugin_editorial_aeo_questions WHERE slug = ?').bind(slug).first();
}
async function writeAeoQuestionRow(api, { slug, question, target_keyword = null, priority = 5, status = 'pending', scheduled_for = null, notes = null }) {
  if (!slug || !question) throw new Error('slug + question required');
  const t = now();
  const existing = await readAeoQuestionRow(api, slug);
  if (existing) {
    await api.db.prepare(
      `UPDATE plugin_editorial_aeo_questions SET question=?, target_keyword=?, priority=?, status=?, scheduled_for=?, notes=?, updated_at=? WHERE slug=?`,
    ).bind(question, target_keyword, priority, status, scheduled_for, notes, t, slug).run();
  } else {
    await api.db.prepare(
      `INSERT INTO plugin_editorial_aeo_questions (slug, question, target_keyword, priority, status, scheduled_for, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(slug, question, target_keyword, priority, status, scheduled_for, notes, t, t).run();
  }
  await api.log('aeo_question_upserted', { slug, status });
  return readAeoQuestionRow(api, slug);
}

// Turn a heartbeat signal into a pending AEO question, seeded with the
// article's real content so the eventual write reacts to what the source
// actually says, not just its headline. Marks the signal actioned.
export async function signalToBlog(api, signalId) {
  const sig = await readSignalContent(api, signalId);   // fetches full article if not cached
  if (!sig) return { ok: false, error: 'signal not found' };
  let base = String(sig.title).toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 60).replace(/^-|-$/g, '');
  let slug = base;
  for (let i = 2; await readAeoQuestionRow(api, slug); i++) slug = `${base}-${i}`;
  await writeAeoQuestionRow(api, {
    slug,
    question: sig.suggested_angle || sig.title,
    target_keyword: null,
    priority: 2,
    status: 'pending',
    notes: `From heartbeat signal (${sig.source_name}). Angle: ${sig.suggested_angle || '—'}. Source: ${sig.url}`,
  });
  if (sig.full_text) {
    const ctx = { from_signal: signalId, source: sig.source_name, source_url: sig.url,
      answers: `Source article ("${sig.title}", ${sig.source_name}):\n\n${sig.full_text.slice(0, 6000)}\n\nThe operator's angle on it: ${sig.suggested_angle || '(take a contrarian, on-brand stance)'}` };
    await api.db.prepare(`UPDATE plugin_editorial_aeo_questions SET expert_context_json=? WHERE slug=?`).bind(JSON.stringify(ctx), slug).run();
  }
  await api.db.prepare(`UPDATE plugin_editorial_osint_signals SET status='actioned' WHERE id=?`).bind(signalId).run();
  return { ok: true, slug, question: sig.suggested_angle || sig.title, read_full_article: !!sig.full_text, note: 'Created as an AEO question (priority 2), seeded with the article\'s real content. Run aeo_start_interview to add the operator\'s take, or write directly.' };
}

// Draft a social post reacting to a signal, in the company's voice. Draft
// only — the operator reviews before anything is published.
export async function signalToSocialDraft(api, signalId) {
  const sig = await api.db.prepare('SELECT * FROM plugin_editorial_osint_signals WHERE id = ?').bind(signalId).first();
  if (!sig) return { ok: false, error: 'signal not found' };
  const voice = await api.knowledge(BRAND_VOICE_SLUG).catch(() => null);
  const draft = await api.gateway('llm', 'text', {
    system: `You write LinkedIn posts for the operator, in their company's voice. Sharp, contrarian-but-earned, no hashtags spam, no "thrilled to announce". One strong idea, a clear take, ends on a line that lands. 80-150 words.\n\n${voice?.body ? 'Brand voice:\n' + voice.body : ''}`,
    prompt: `React to this industry item with a post that gives the operator's POV:\n\nTitle: ${sig.title}\nAngle: ${sig.suggested_angle || ''}\nSource: ${sig.url}\n\nWrite the post.`,
  });
  return { ok: true, draft, signal_title: sig.title, note: 'Draft only — operator reviews before posting. Use the LinkedIn post tool to publish if approved.' };
}
