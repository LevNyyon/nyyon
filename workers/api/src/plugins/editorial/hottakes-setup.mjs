// Editorial plugin · Hot Takes first run — ported from workers/api/src/lib/hottakes-setup.js.
//
// The awareness feed only works if it knows what to watch. A fresh install
// watches whatever defaults shipped (AI labs and marketing press), which for
// most operators is somebody else's industry. This is the one-time surface
// that fixes that, inside the module, before the operator has to learn what an
// "osint_source" is.
//
// Four jobs, in order:
//
//   1. READ what onboarding already learned — company-profile, the ICP, the
//      point-of-view library, heartbeat priorities. If those are still the
//      shipped placeholders we SAY SO instead of pretending to personalise; the
//      caller then asks the operator for one line about their world.
//   2. PROPOSE real sources. The llm gateway invents candidates (it is good at
//      "who publishes about X" and terrible at remembering exact feed paths),
//      then every candidate is FETCHED through the web gateway and parsed with
//      the same parseFeed the ingest uses. Only feeds that really parsed are
//      offered, with the item count we actually saw. A 404 that looks plausible
//      is worse than no proposal, so nothing unvalidated ever leaves here.
//   3. APPLY the operator's picks — real plugin_editorial_osint_sources rows,
//      real plugin_editorial_osint_targets for brand/competitor listening, and
//      their own words written into the `plugin-editorial-heartbeat-priorities`
//      note (between sentinels, so the gates block and any prose they added
//      survive).
//   4. REMEMBER that this ran, through the host `setup` gateway, so it never
//      opens again unattended. Skipping counts: an operator who closed it
//      deliberately gets an empty-but-working module, not a nag.
//
// Every tunable — how many candidates to ask for, the fetch timeout, the item
// floor, the paths probed when a URL misses, the placeholder markers that
// identify an un-personalised doc — is read from the
// `plugin-editorial-hottakes-source-scout` knowledge note at call time. The
// frozen defaults below are the fallback for a note that has been deleted or
// has a broken JSON block, nothing more.
//
// Contract v2.1 lib file: imports NOTHING; every exported function takes `api`
// first. Helpers shared with heartbeat.mjs / osint.mjs (parseFeed, gnewsUrl,
// source/target CRUD) are duplicated below — contract: no lib-to-lib imports.

export const MODULE = 'hottakes';
export const SCOUT_SLUG = 'plugin-editorial-hottakes-source-scout';
const PRIORITIES_SLUG = 'plugin-editorial-heartbeat-priorities';

// The docs the first run reads before it proposes anything. The pov-library
// alt is the plugin's own seeded copy: the pack seed ships the plugin-scoped
// one and the host onboarding interview writes the global one, and either
// counts as "the operator told us what they argue".
const SOURCE_DOCS = [
  { key: 'company_profile',      slug: 'company-profile',   label: 'Company profile' },
  { key: 'icp',                  slug: 'icp',               label: 'ICP', alt: 'brand-icp' },
  { key: 'pov_library',          slug: 'pov-library',       label: 'Point-of-view library', alt: 'plugin-editorial-hottakes-pov-library' },
  { key: 'heartbeat_priorities', slug: PRIORITIES_SLUG,     label: 'Heartbeat priorities' },
];

const FEED_UA = 'heartbeat-rss/1.0';

// Sentinels around the section this flow owns inside the priorities note.
// Everything outside them is the operator's (or the seed's) and is never
// touched — including the fenced ```json gates block the gate editor edits.
// Unchanged from the host module, so a migrated note keeps its section.
const WATCH_OPEN  = '<!-- hottakes-setup:watch -->';
const WATCH_CLOSE = '<!-- /hottakes-setup:watch -->';

const SCOUT_DEFAULTS = Object.freeze({
  candidate_feeds:    12,   // how many feed URLs to ask the model for
  candidate_topics:   6,    // how many Google News queries to ask for
  max_validations:    26,   // hard ceiling on fetches per proposal run
  validate_timeout_ms: 9000,
  max_feed_bytes:     400000,
  min_items:          2,    // a feed with fewer parsed items is not offered
  probe_paths:        ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml'],
  max_probe_paths:    3,    // conventional paths tried when the given URL misses
  themes:             ['general', 'industry', 'competitor', 'brand', 'market', 'technology'],
  placeholder_markers: [
    'REQUIRED.',
    'Replace the placeholders',
    'Replace every\nline below',
    'Replace with your own subject matter',
    'The quality gates the awareness sweep applies',
    'Nothing captured yet',
  ],
  min_personal_chars: 200,
});

const SCOUT_BODY = `# Hot Takes — source scout (first run)

How the module's one-time setup proposes what to watch. The procedure lives
here, not in code: edit this note and the next first run behaves differently
with no deploy.

## What the scout is for

A fresh install watches the feeds that shipped with it. That is somebody else's
industry. This scout reads what setup already learned about the operator, asks
the model who actually publishes in their world, and then PROVES each answer by
fetching it. Nothing that failed to fetch and parse is ever offered.

## What it reads first

\`company-profile\`, \`icp\`, \`pov-library\` and \`plugin-editorial-heartbeat-priorities\`.
If those are still the shipped placeholders the scout must say so plainly and
ask the operator for one line about what they do and who it is for, rather than
proposing a generic industry. Guessing here is how an install ends up watching
the wrong market confidently.

## What it asks for

- **Feeds** — real RSS/Atom URLs from publications, trade press, associations,
  research groups and notable company blogs in the operator's field. Prefer
  publications that post several times a week. A feed URL the model is unsure
  of should still be offered WITH the site's homepage, so the scout can probe
  the conventional paths itself.
- **Topics** — Google News queries in the operator's language of trade: named
  companies, named technologies, named regulations. Queries beat adjectives.
- **Brands and competitors** — the operator's own names, and the handful of
  rivals worth a standing listener.
- **Keywords and an ignore list** — the words that make an item theirs, and the
  neighbouring subject that keeps showing up and never matters.

## The rules the scout obeys

1. Never offer a feed that was not fetched and parsed. Report the item count.
2. Never offer a source that is already being watched.
3. A guess about a URL is fine to ATTEMPT and never fine to present.
4. Everything is optional. An operator who skips gets an empty module that
   works, not a broken one.

## Tunables

\`candidate_feeds\` / \`candidate_topics\` size the ask. \`max_validations\` is the
fetch ceiling for one proposal run (it bounds the worker's subrequest budget).
\`min_items\` is how many parsed entries a feed needs before it counts as alive.
\`probe_paths\` are the conventional feed paths tried when the model's URL misses,
capped by \`max_probe_paths\`. \`placeholder_markers\` are the phrases that identify
a knowledge note still carrying its shipped placeholder text.

\`\`\`json
${JSON.stringify(SCOUT_DEFAULTS, null, 2)}
\`\`\`
`;

// ── duplicated helpers (contract: no lib-to-lib imports) ─────────────────────

const now = () => Date.now();
const uid = () => crypto.randomUUID();

// The one Google News URL builder. writeSource turns a gnews `query` into this
// URL at save time, and the scout FETCHES the built URL to prove a topic query
// actually returns items before it offers it. One definition here, the same
// string shape as heartbeat.mjs builds, so a proposal is validated against the
// exact URL that gets saved.
const gnewsUrl = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(String(q || ''))}&hl=en-US&gl=US&ceid=US:en`;

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

function tagOf(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : null;
}

// RSS + Atom, regex-based (workerd has no DOMParser). SAME parser shape the
// hourly ingest uses, so "validated" means one thing in this pack.
function parseFeed(xml) {
  if (!xml) return [];
  const out = [];
  const isAtom = /<entry[\s>]/i.test(xml) && !/<item[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s\S]*?<\/entry>/gi : /<item[\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const title = decode(tagOf(b, 'title') || '');
    let link = null;
    if (isAtom) {
      // prefer rel="alternate" or first <link href="...">
      const alt = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
               || b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = alt ? alt[1] : null;
    } else {
      link = decode(tagOf(b, 'link') || '');
      // Google News wraps the real URL; the <link> text is the redirector — fine, still unique.
    }
    const summaryRaw = tagOf(b, 'description') || tagOf(b, 'summary') || tagOf(b, 'content') || '';
    const summary = decode(summaryRaw).slice(0, 600);
    const dateStr = tagOf(b, 'pubDate') || tagOf(b, 'published') || tagOf(b, 'updated') || null;
    if (!title || !link) continue;
    out.push({ title, url: link.trim(), summary, published_at: parseDate(dateStr) });
  }
  return out;
}

// ── sources CRUD (duplicated from heartbeat.mjs, plugin tables) ─────────────

async function listSources(api) {
  const r = await api.db.prepare('SELECT * FROM plugin_editorial_osint_sources ORDER BY kind, name').all();
  return r.results || [];
}

async function writeSource(api, body = {}) {
  const id = body.id || uid();
  const existing = body.id
    ? await api.db.prepare('SELECT * FROM plugin_editorial_osint_sources WHERE id = ?').bind(body.id).first()
    : null;
  const kind = body.kind ?? existing?.kind ?? 'rss';
  // gnews sources can be authored by plain query text — we build the feed URL.
  const url = body.url ?? (body.query && kind === 'gnews' ? gnewsUrl(String(body.query)) : existing?.url);
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

// ── targets CRUD (duplicated from osint.mjs, plugin tables) ─────────────────
// The list here skips the mentions-count join the OSINT surface wants: this
// flow only needs identity (name -> row) to keep applySetup idempotent.

async function listTargets(api) {
  const r = await api.db.prepare('SELECT * FROM plugin_editorial_osint_targets ORDER BY updated_at DESC').all();
  return r.results || [];
}

async function readTarget(api, id) {
  return api.db.prepare('SELECT * FROM plugin_editorial_osint_targets WHERE id = ?').bind(id).first();
}

async function writeTarget(api, body) {
  const id = body.id || ('tgt_' + uid().slice(0, 10));
  const t = now();
  const existing = await readTarget(api, id);
  if (existing) {
    await api.db.prepare(`
      UPDATE plugin_editorial_osint_targets
         SET name = ?, domain = ?, app_id = ?, notes = ?, updated_at = ?, updated_by = ?
       WHERE id = ?
    `).bind(
      body.name ?? existing.name,
      body.domain ?? existing.domain,
      body.app_id ?? existing.app_id,
      body.notes ?? existing.notes,
      t,
      body.updated_by || 'operator',
      id,
    ).run();
  } else {
    if (!body.name) throw new Error('name required');
    await api.db.prepare(`
      INSERT INTO plugin_editorial_osint_targets (id, name, domain, app_id, notes, created_at, updated_at, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, body.name, body.domain || null, body.app_id || null, body.notes || null,
      t, t, body.created_by || 'operator', body.updated_by || 'operator',
    ).run();
  }
  await api.log(existing ? 'osint_target_updated' : 'osint_target_added', { id, name: body.name ?? existing?.name });
  return readTarget(api, id);
}

// ── the note ────────────────────────────────────────────────────────────────
// Same contract as the host original: seed on first read, never throw.
export async function loadScoutNote(api) {
  try {
    const doc = await api.knowledge(SCOUT_SLUG);
    if (!doc) {
      await api.saveKnowledge(SCOUT_SLUG, {
        title: 'Hot Takes — source scout (first run)',
        body: SCOUT_BODY,
      }).catch(() => {});
      return SCOUT_BODY;
    }
    return String(doc.body || '') || SCOUT_BODY;
  } catch { return SCOUT_BODY; }
}

// Numbers + lists out of the note's fenced JSON block, defaults for anything
// missing or malformed. Never throws: a broken note degrades to the defaults
// rather than taking the module's first run down with it.
export async function scoutTunables(api) {
  const out = { ...SCOUT_DEFAULTS };
  try {
    const body = await loadScoutNote(api);
    const m = String(body).match(/```json\s*([\s\S]*?)```/);
    if (!m) return out;
    const src = JSON.parse(m[1]);
    for (const [k, dflt] of Object.entries(SCOUT_DEFAULTS)) {
      const v = src[k];
      if (Array.isArray(dflt)) {
        if (Array.isArray(v) && v.length) out[k] = v.map(String);
      } else if (typeof dflt === 'number') {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) out[k] = n;
      }
    }
  } catch { /* defaults */ }
  return out;
}

// ── module_setup (the "has this run" receipt, via the host setup gateway) ───
// The receipt store is HOST data: reads and writes both go through
// api.gateway('setup', ...). The gateway fail-softs a missing row to null,
// which means "offer the first run".
async function readSetupRow(api) {
  try {
    return (await api.gateway('setup', 'read', { module: MODULE })) || null;
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) return null;
    throw e;
  }
}

async function writeSetupRow(api, { status, actor, summary }) {
  const t = now();
  await api.gateway('setup', 'write', {
    module: MODULE,
    status,
    completed_at: t,
    actor: actor || 'operator',
    summary: summary ? JSON.stringify(summary) : null,
  });
  return { module: MODULE, status, completed_at: t };
}

// ── is a knowledge note still the shipped placeholder? ──────────────────────
// Three ways a doc reads as un-personalised: it does not exist, it is shorter
// than a sentence or two, or it still carries one of the marker phrases the
// seed writes into its placeholders. The markers live in the scout note, so a
// reworded seed is a note edit rather than a code change.
function looksDefault(body, tune) {
  const text = String(body || '').trim();
  if (!text) return true;
  if (text.replace(/\s+/g, ' ').length < tune.min_personal_chars) return true;
  const flat = text.replace(/\s+/g, ' ');
  return tune.placeholder_markers.some((m) => flat.includes(String(m).replace(/\s+/g, ' ')));
}

// Reads all four docs and reports, per doc, whether it carries the operator's
// own material. `personalised` is the honest headline the UI leads with.
export async function readPersonalisation(api) {
  const tune = await scoutTunables(api);
  const docs = {};
  for (const d of SOURCE_DOCS) {
    let doc = await api.knowledge(d.slug).catch(() => null);
    let usedSlug = d.slug;
    if (!doc && d.alt) {
      doc = await api.knowledge(d.alt).catch(() => null);
      if (doc) usedSlug = d.alt;
    }
    const body = String(doc?.body || '');
    // The priorities note is the one doc this flow itself writes into, and it
    // keeps the seed's gate prose (markers and all) on purpose. Our sentinel is
    // therefore the authoritative "an operator has said what to watch" signal.
    const owned = d.slug === PRIORITIES_SLUG && body.includes(WATCH_OPEN);
    docs[d.key] = {
      slug: usedSlug,
      label: d.label,
      exists: Boolean(doc),
      personal: owned || (Boolean(doc) && !looksDefault(body, tune)),
      chars: body.length,
    };
  }
  const personal = Object.values(docs).filter((d) => d.personal);
  return {
    personalised: personal.length > 0,
    docs,
    // What the scout can actually build a prompt out of.
    material: personal.map((d) => d.slug),
  };
}

// The prompt material, capped so a long POV library cannot blow the budget.
async function personalContext(api, personalisation, hint) {
  const parts = [];
  for (const d of SOURCE_DOCS) {
    const info = personalisation.docs[d.key];
    if (!info?.personal) continue;
    const doc = await api.knowledge(info.slug).catch(() => null);
    if (!doc?.body) continue;
    parts.push(`## ${d.label} (${info.slug})\n${String(doc.body).slice(0, 4000)}`);
  }
  if (hint) parts.push(`## What the operator just told us, in their own words\n${String(hint).slice(0, 1200)}`);
  return parts.join('\n\n');
}

// ── state ───────────────────────────────────────────────────────────────────
// The one question the page asks on mount: do I open the first run, and what do
// I already know. Cheap — four doc reads and three counts, no network.
export async function readSetupState(api) {
  const row = await readSetupRow(api).catch(() => null);
  const [personalisation, sources] = await Promise.all([
    readPersonalisation(api).catch(() => ({ personalised: false, docs: {}, material: [] })),
    listSources(api).catch(() => []),
  ]);
  const counts = await api.db.prepare(
    `SELECT (SELECT COUNT(*) FROM plugin_editorial_osint_signals) AS signals,
            (SELECT COUNT(*) FROM plugin_editorial_osint_topics)  AS topics`,
  ).first().catch(() => ({ signals: 0, topics: 0 }));

  let summary = null;
  try { summary = row?.summary ? JSON.parse(row.summary) : null; } catch { summary = null; }

  return {
    module: MODULE,
    // The whole point: no receipt (or a reopened one) opens the panel, and a
    // done/skipped receipt closes it for good. The setup gateway has no delete
    // mode, so "reopened" is a status the receipt carries rather than a
    // missing row — same behaviour, auditable trail.
    first_run_needed: !row || row.status === 'reopened',
    status: row?.status || 'pending',
    completed_at: row?.completed_at ?? null,
    summary,
    personalisation,
    sources: {
      total: sources.length,
      enabled: sources.filter((s) => s.enabled).length,
      feeds: sources.filter((s) => s.kind === 'rss').length,
      topics: sources.filter((s) => s.kind === 'gnews').length,
    },
    signals: Number(counts?.signals || 0),
    hot_topics: Number(counts?.topics || 0),
  };
}

// ── feed validation ─────────────────────────────────────────────────────────
// The guardrail, in one function: a URL is only real if we fetched it and
// parseFeed (the SAME parser the hourly ingest uses) found entries in it. Both
// the pasted-URL check and the proposal run go through here, so "validated"
// means one thing in this pack.
export async function validateFeed(api, { url, timeout_ms = null, tune = null } = {}) {
  const t = tune || await scoutTunables(api);
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) {
    return { ok: false, url: clean, error: 'not an http(s) URL' };
  }
  let r;
  try {
    r = await api.gateway('web', 'text', {
      url: clean,
      timeout_ms: timeout_ms || t.validate_timeout_ms,
      max_bytes: t.max_feed_bytes,
      headers: { 'user-agent': FEED_UA },
    });
  } catch (e) {
    return { ok: false, url: clean, error: String(e?.message || e).slice(0, 160) };
  }
  if (!r.ok) return { ok: false, url: clean, status: r.status, error: `HTTP ${r.status}` };

  const items = parseFeed(r.text);
  if (items.length < t.min_items) {
    const isHtml = /<html[\s>]/i.test(String(r.text || '').slice(0, 2000));
    return {
      ok: false, url: clean, status: r.status, items: items.length,
      error: items.length === 0
        ? (isHtml ? 'that URL is a web page, not a feed' : 'nothing parsed as a feed')
        : `only ${items.length} item${items.length === 1 ? '' : 's'} parsed`,
    };
  }
  const dates = items.map((i) => i.published_at).filter((n) => Number.isFinite(n));
  return {
    ok: true,
    url: clean,
    status: r.status,
    content_type: r.content_type || null,
    items: items.length,
    latest_at: dates.length ? Math.max(...dates) : null,
    sample: items.slice(0, 3).map((i) => i.title).filter(Boolean),
  };
}

// ── the proposal run ────────────────────────────────────────────────────────
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function originOf(u) { try { return new URL(u).origin; } catch { return ''; } }

function scoutSystem(noteBody, tune) {
  return [
    'You are scouting the information sources one company should monitor. You are NOT writing marketing copy; you are naming real publications and real search queries in their field.',
    '',
    '# The scout note (your procedure)',
    '',
    noteBody,
    '',
    '# Output',
    '',
    'Reply with ONE JSON object and nothing else:',
    '{',
    '  "industry": "one plain sentence naming the field you are scouting for",',
    `  "feeds": [ { "name": "publication name", "url": "https://…/feed", "site": "https://…", "theme": "one of ${tune.themes.join('|')}", "why": "one short clause" } ],`,
    '  "topics": [ { "name": "short label", "query": "the Google News search string", "theme": "…", "why": "one short clause" } ],',
    '  "brands": ["names the operator owns and should hear about"],',
    '  "competitors": ["rival names worth a standing listener"],',
    '  "keywords": ["words that make an item theirs"],',
    '  "ignore": ["the adjacent subject that keeps showing up and never matters"]',
    '}',
    '',
    `Give up to ${tune.candidate_feeds} feeds and ${tune.candidate_topics} topics.`,
    'ALWAYS include "site" (the publication homepage) next to every feed URL: your memory of exact feed paths is unreliable, and the caller probes the site itself when your URL misses. A wrong path costs nothing; a missing site costs the whole entry.',
    'Do not pad. Six real publications beat twelve invented ones. Do not name a publication you are not confident exists.',
    'Prefer publications that post at least weekly. Prefer trade press, associations, regulators and research groups over general news.',
    'For topics, use the nouns of the trade: named companies, named technologies, named regulations, named venues. Adjectives return noise.',
  ].join('\n');
}

// Bounded, concurrent validation. `budget` is decremented across the whole run
// so probing never runs away with the worker's subrequest allowance, and `seen`
// carries every URL already spoken for (existing sources + everything accepted
// so far). The second one is not tidiness: two different publications can share
// one feed host — Metal Hammer and The Pit both resolve to loudersound.com/feed
// — and offering the same URL twice invites the operator to add a duplicate.
async function validateCandidates(api, candidates, tune, budget, seen) {
  const out = [];
  const rejected = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const slice = candidates.slice(i, i + CONCURRENCY);
    const checked = await Promise.all(slice.map(async (cand) => {
      // Candidate URLs to TRY, in order: what the model said, then the
      // conventional paths under its homepage. Every one is really fetched, so
      // whatever survives has been proven, never guessed.
      const tries = [];
      if (cand.url) tries.push(String(cand.url).trim());
      const base = originOf(cand.site || cand.url || '');
      if (base) {
        for (const p of tune.probe_paths.slice(0, tune.max_probe_paths)) {
          const u = base + p;
          if (!tries.includes(u)) tries.push(u);
        }
      }
      if (!tries.length) return { ok: false, cand, error: 'no URL to try' };
      // Reported honestly rather than as a fetch failure: "we ran out of budget
      // before checking this" is a different fact from "this feed is dead", and
      // the operator can tell them apart.
      let lastError = 'not checked — the fetch budget for this run was spent';
      for (const u of tries) {
        if (budget.left <= 0) break;
        budget.left -= 1;
        const v = await validateFeed(api, { url: u, tune });
        if (v.ok) return { ok: true, cand, v };
        lastError = v.error || 'failed';
      }
      return { ok: false, cand, error: lastError };
    }));

    for (const c of checked) {
      if (c.ok) {
        if (seen.has(c.v.url)) {
          rejected.push({ name: String(c.cand.name || '').slice(0, 80), url: c.v.url, error: 'same feed as another source' });
          continue;
        }
        seen.add(c.v.url);
        out.push({
          kind: c.cand.kind || 'rss',
          name: String(c.cand.name || hostOf(c.v.url) || 'Untitled').slice(0, 80),
          url: c.v.url,
          query: c.cand.query || null,
          theme: tune.themes.includes(String(c.cand.theme)) ? String(c.cand.theme) : 'general',
          why: String(c.cand.why || '').slice(0, 160),
          items: c.v.items,
          latest_at: c.v.latest_at,
          sample: c.v.sample,
        });
      } else {
        rejected.push({ name: String(c.cand.name || '').slice(0, 80), url: c.cand.url || c.cand.site || '', error: c.error });
      }
    }
  }
  return { out, rejected };
}

/**
 * Propose sources for this operator, validated.
 *
 * Returns {ok:false, reason:'no_material'} when neither the knowledge docs nor
 * an operator hint say anything about their world — the caller must ask rather
 * than let the model invent an industry.
 */
export async function proposeSources(api, { hint = '', actor = 'operator' } = {}) {
  const tune = await scoutTunables(api);
  const personalisation = await readPersonalisation(api);
  const cleanHint = String(hint || '').trim();

  if (!personalisation.personalised && !cleanHint) {
    return {
      ok: false,
      reason: 'no_material',
      personalisation,
      message: 'Setup did not leave anything about your industry — these notes are still the shipped placeholders. Tell me in one line what you do and who it is for, and I will scout from that.',
    };
  }

  const note = await loadScoutNote(api);
  const context = await personalContext(api, personalisation, cleanHint);
  const existing = await listSources(api).catch(() => []);
  const known = new Set(existing.map((s) => String(s.url || '').trim()));
  const knownHosts = new Set(existing.filter((s) => s.kind === 'rss').map((s) => hostOf(s.url)).filter(Boolean));

  let out;
  try {
    out = await api.gateway('llm', 'json', {
      system: scoutSystem(note, tune),
      prompt: [
        'Here is everything this install knows about the operator:',
        '',
        context || '(nothing on file)',
        '',
        existing.length
          ? `Already watched (do NOT propose these again): ${existing.map((s) => `${s.name} <${hostOf(s.url) || s.url}>`).join(', ').slice(0, 1500)}`
          : 'Nothing is being watched yet.',
        '',
        'Scout their sources now. Return the JSON.',
      ].join('\n'),
    });
  } catch (e) {
    return { ok: false, reason: 'llm_failed', personalisation, message: String(e?.message || e).slice(0, 200) };
  }

  const budget = { left: tune.max_validations };
  // Pre-loaded with what is already watched, so a probe that happens to land on
  // an existing feed URL is dropped rather than offered as new.
  const seen = new Set(known);

  // Feeds: candidate URL + homepage probe, both really fetched.
  const feedCandidates = (Array.isArray(out?.feeds) ? out.feeds : [])
    .filter((f) => f && (f.url || f.site))
    .filter((f) => !known.has(String(f.url || '').trim()) && !knownHosts.has(hostOf(f.url || f.site)))
    .slice(0, tune.candidate_feeds)
    .map((f) => ({ ...f, kind: 'rss' }));

  // Topics: the built Google News URL is fetched too, so a query that returns
  // nothing this week is reported as empty instead of quietly added.
  const topicCandidates = (Array.isArray(out?.topics) ? out.topics : [])
    .filter((t) => t && t.query)
    .slice(0, tune.candidate_topics)
    .map((t) => ({ ...t, kind: 'gnews', url: gnewsUrl(t.query), site: null }))
    .filter((t) => !known.has(t.url));

  // Topics first: a Google News query is one fetch with a guaranteed answer,
  // where a publication feed can burn up to max_probe_paths tries before it
  // gives up. Spending the budget on the cheap certain half first is why a run
  // that hits the ceiling still comes back with a usable spread.
  const topics = await validateCandidates(api, topicCandidates, tune, budget, seen);
  const feeds = await validateCandidates(api, feedCandidates, tune, budget, seen);

  const proposals = [...feeds.out, ...topics.out];
  const rejected = [...feeds.rejected, ...topics.rejected];

  // A proposal run is a read, but it spends the operator's model budget and it
  // is the thing they will ask about later ("where did these come from") — so
  // it goes on the bus like every other meaningful action.
  await api.log('hottakes_sources_proposed', {
    actor,
    industry: String(out?.industry || '').slice(0, 200),
    offered: proposals.length, rejected: rejected.length,
    fetches: tune.max_validations - budget.left,
    from_hint: Boolean(cleanHint),
  });

  return {
    ok: true,
    personalisation,
    industry: String(out?.industry || '').slice(0, 300),
    proposals,
    // Shown, not hidden: the operator should see that we checked and what died.
    rejected,
    fetches: tune.max_validations - budget.left,
    brands: (Array.isArray(out?.brands) ? out.brands : []).map(String).slice(0, 8),
    competitors: (Array.isArray(out?.competitors) ? out.competitors : []).map(String).slice(0, 8),
    keywords: (Array.isArray(out?.keywords) ? out.keywords : []).map(String).slice(0, 16),
    ignore: (Array.isArray(out?.ignore) ? out.ignore : []).map(String).slice(0, 12),
  };
}

// ── writing the operator's words into the priorities note ───────────────────
// Replaces only the sentinel-delimited block. The seed's gate prose, the fenced
// JSON block the gate editor owns, and anything the operator typed by hand all
// survive untouched.
function composeWatchSection({ topics, keywords, ignore, note }) {
  const bullets = (arr) => (arr.length ? arr.map((s) => `- ${s}`).join('\n') : '_none given_');
  return [
    WATCH_OPEN,
    '## What we watch',
    '',
    `Set from the Hot Takes first run on ${new Date().toISOString().slice(0, 10)}, in the operator's own words.`,
    'The scorer reads this on every sweep, so editing it changes what gets through.',
    '',
    '**Topics that matter**',
    bullets(topics),
    '',
    '**Names and keywords to catch**',
    bullets(keywords),
    '',
    '**Not relevant to us**',
    bullets(ignore),
    ...(note ? ['', '**Operator note**', '', note] : []),
    WATCH_CLOSE,
  ].join('\n');
}

async function writeWatchSection(api, watch) {
  const topics   = (watch?.topics   || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  const keywords = (watch?.keywords || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
  const ignore   = (watch?.ignore   || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 20);
  const note     = String(watch?.note || '').trim().slice(0, 2000);
  if (!topics.length && !keywords.length && !ignore.length && !note) return { written: false };

  const doc = await api.knowledge(PRIORITIES_SLUG).catch(() => null);
  const body = String(doc?.body || '');
  const section = composeWatchSection({ topics, keywords, ignore, note });

  let next;
  const open = body.indexOf(WATCH_OPEN);
  const close = body.indexOf(WATCH_CLOSE);
  if (open >= 0 && close > open) {
    next = body.slice(0, open) + section + body.slice(close + WATCH_CLOSE.length);
  } else if (body.trim()) {
    // Before the gates block if there is one, so the machine-readable numbers
    // stay last and the human section reads first.
    const gates = body.search(/```json/);
    next = gates >= 0
      ? body.slice(0, gates) + section + '\n\n' + body.slice(gates)
      : body.replace(/\s*$/, '\n\n') + section + '\n';
  } else {
    next = `# Heartbeat priorities\n\n${section}\n`;
  }

  await api.saveKnowledge(PRIORITIES_SLUG, {
    title: doc?.title || 'Heartbeat priorities',
    body: next,
  });
  return { written: true, topics: topics.length, keywords: keywords.length, ignore: ignore.length };
}

/**
 * Apply the operator's picks and close the first run.
 *
 * Everything is optional — an operator who ticked nothing still gets a row, so
 * the panel stops opening and the module works empty. Per-item failures are
 * collected and reported rather than aborting: half the sources landing is a
 * better outcome than one bad URL rolling back the whole setup.
 */
export async function applySetup(api, { sources = [], targets = [], watch = null, ran_ingest = false, actor = 'operator' } = {}) {
  const added = [];
  const kept = [];      // already watched — reported, never duplicated
  const failed = [];

  const tune = await scoutTunables(api);

  // Applying is IDEMPOTENT, because "Run setup again" is a real button and the
  // first run can be answered twice. Both stores upsert by identity rather than
  // by row id: a source by its feed URL (writeSource inserts whenever no id is
  // passed) and a listener by its name (writeTarget mints a fresh tgt_ id every
  // time). Without these two lookups a second pass silently doubles every
  // source and every listener.
  const existingSources = await listSources(api).catch(() => []);
  const sourceByUrl = new Map(existingSources.map((r) => [String(r.url || '').trim(), r]));
  const existingTargets = await listTargets(api).catch(() => []);
  const targetByName = new Map((existingTargets || []).map((r) => [String(r.name || '').trim().toLowerCase(), r]));

  for (const s of Array.isArray(sources) ? sources : []) {
    try {
      const kind = s?.kind === 'gnews' ? 'gnews' : 'rss';
      // gnews rows are stored as the built search URL, so the same query maps
      // to the same key as an existing row.
      const identity = kind === 'gnews' && s?.query ? gnewsUrl(String(s.query)) : String(s?.url || '').trim();
      const already = sourceByUrl.get(identity);
      if (already) { kept.push({ id: already.id, name: already.name, kind: already.kind }); continue; }
      // The guardrail has to hold on the WRITE, not only in the UI. Anything
      // this module proposed or checked arrives carrying the item count it was
      // proven with; anything else (a tool call, a hand-built payload) is
      // fetched here before it can become a source. A dead feed is reported as
      // a failure, never written — writeSource itself only checks that the
      // string looks like a URL.
      if (kind === 'rss' && !(Number(s?.items) > 0)) {
        const check = await validateFeed(api, { url: String(s?.url || '').trim(), tune });
        if (!check.ok) {
          failed.push({ name: String(s?.name || s?.url || 'source'), error: `not a working feed: ${check.error}` });
          continue;
        }
      }
      const row = await writeSource(api, {
        kind,
        name: String(s?.name || '').trim(),
        // gnews rows are authored by query so the stored URL is always the one
        // writeSource builds — never a hand-assembled twin of it.
        ...(kind === 'gnews' && s?.query ? { query: String(s.query) } : { url: String(s?.url || '').trim() }),
        theme: s?.theme || 'general',
        enabled: true,
      });
      sourceByUrl.set(String(row.url || '').trim(), row);
      added.push({ id: row.id, name: row.name, kind: row.kind });
    } catch (e) {
      failed.push({ name: String(s?.name || s?.url || 'source'), error: String(e?.message || e).slice(0, 160) });
    }
  }

  const listeners = [];
  for (const t of Array.isArray(targets) ? targets : []) {
    const name = String(t?.name || '').trim();
    if (!name) continue;
    try {
      const already = targetByName.get(name.toLowerCase());
      if (already) { listeners.push({ id: already.id, name: already.name, existing: true }); continue; }
      const row = await writeTarget(api, {
        name,
        domain: String(t?.domain || '').trim() || null,
        notes: t?.kind === 'competitor' ? 'competitor (added during Hot Takes setup)' : 'brand (added during Hot Takes setup)',
        created_by: actor, updated_by: actor,
      });
      if (row?.id) targetByName.set(name.toLowerCase(), row);
      listeners.push({ id: row?.id, name });
    } catch (e) {
      failed.push({ name, error: String(e?.message || e).slice(0, 160) });
    }
  }

  let watchResult = { written: false };
  try { watchResult = await writeWatchSection(api, watch); }
  catch (e) { failed.push({ name: PRIORITIES_SLUG, error: String(e?.message || e).slice(0, 160) }); }

  const summary = {
    sources_added: added.length,
    // Counted separately so a second pass reads "nothing new" rather than
    // claiming credit for sources and names that were already there.
    sources_kept: kept.length,
    listeners_added: listeners.filter((l) => !l.existing).length,
    listeners_kept: listeners.filter((l) => l.existing).length,
    watch_written: Boolean(watchResult.written),
    ran_ingest: Boolean(ran_ingest),
    failed: failed.length,
  };
  const row = await writeSetupRow(api, { status: 'done', actor, summary });

  await api.log('hottakes_setup_completed', { actor, ...summary });

  return { ok: true, ...row, summary, added, kept, listeners, failed, watch: watchResult };
}

// Skipping is a DECISION, recorded like any other. It closes the panel for good
// (the module works empty), and the operator can reopen it from Approved
// Sources whenever they want — which is attended, so it never nags.
export async function skipSetup(api, { actor = 'operator' } = {}) {
  const row = await writeSetupRow(api, { status: 'skipped', actor, summary: { sources_added: 0, sources_kept: 0, listeners_added: 0, listeners_kept: 0, watch_written: false, ran_ingest: false, failed: 0 } });
  await api.log('hottakes_setup_skipped', { actor, module: MODULE });
  return { ok: true, ...row };
}

// The attended re-run: reopens the panel on request. The host original DELETED
// the receipt row; the setup gateway exposes no delete mode, so the port writes
// status='reopened' instead and readSetupState treats that status as "first run
// needed". Same observable behaviour, one honest receipt trail.
export async function reopenSetup(api, { actor = 'operator' } = {}) {
  await writeSetupRow(api, { status: 'reopened', actor, summary: null });
  await api.log('hottakes_setup_reopened', { actor, module: MODULE });
  return { ok: true, module: MODULE, first_run_needed: true };
}
