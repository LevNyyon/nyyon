// Editorial plugin · Hot Takes — ported from workers/api/src/lib/hot-takes.js.
// The editorial "publication package" pool. ONE shared place where the SQL for
// plugin_editorial_hot_take_packages (and for the package's legs in the unified
// plugin_editorial_social_posts table) lives, so the Hot Takes tools delegate
// here and every mutation logs to the activity bus once. This lib does DB +
// orchestration only; NEW reasoning (draft-a-take, brief, review scan, social
// drafting) lives in the tool layer via the `llm` gateway. The one deliberate
// exception is the heavy article write, which REUSES the composeAndSavePost
// pipeline (lib/aeo-writer.mjs) — the article body lands in
// plugin_editorial_blog_posts and is linked back here by blog_slug, inheriting
// figures, cover, publish + edge-render for free.
//
// Distribution safety: LinkedIn legs (postLeg, and the hourly due-scan firing
// them) are gated on the `hottakes.live` feature flag (a host feature_flags
// SELECT — declared host read). Absent/false → DRY RUN (log + preview, no side
// effects). The WEBSITE leg is deliberately NOT gated: publishing to the public
// site is the same trust level as the Blog page's Approve button (also
// ungated), so a scheduled publication really goes live at its date — that is
// the whole point of scheduling it.
//
// Contract v2.1 lib file: imports NOTHING; every exported function takes `api`
// first. Two seams could not stay in-file because lib files may not import
// each other:
//   · writeArticleFromBrief takes { compose } — the calling tool imports
//     composeAndSavePost from './aeo-writer.mjs' and hands it in.
//   · publishWebsite / runDueReleases take { publish } — the calling tool
//     imports the ported publishBlogPostToProd equivalent and hands it in.

const now = () => Date.now();
const genId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

function safeJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// Universal typography guard (host rule, duplicated with the blog port): NO
// en-dashes or em-dashes anywhere in any post. Strip them on EVERY write.
function stripDashes(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\s*—\s*/g, ', ')  // em-dash -> comma + space
    .replace(/\s*–\s*/g, '-');  // en-dash -> hyphen
}

// LIKE-escape helper (verified against live D1; keep in sync with ESCAPE '@').
const LIKE_ESC = '@';
function likeTerm(q) {
  return '%' + String(q).trim().replace(/[@%_]/g, (c) => LIKE_ESC + c) + '%';
}

// One definition of the public article URL — used by scheduling, publishing,
// the calendar mirror, and the social-draft prompt (no scattered copies).
// The plugin runtime exposes no env, so the origin is a plain string the
// caller may supply when it knows one; with none the URL stays site-relative
// until the operator connects a public site (same documented fallback as the
// host module). Publish results carry the real absolute URL from the publish
// pipeline regardless.
export const blogUrl = (slug, origin = '') => {
  const o = String((origin && typeof origin === 'object' ? origin.PUBLIC_ORIGIN : origin) || '').replace(/\/+$/, '');
  return `${o}/blog/${slug}/`;
};

// ── inlined blog-post reads/writes (contract: no lib-to-lib imports) ────────
// The blog store is this same pack's plugin_editorial_blog_posts table; the
// fuller CRUD lives in lib/blog-db.mjs, but this file may not import it.
async function readBlogPostRow(api, slug) {
  return api.db.prepare('SELECT * FROM plugin_editorial_blog_posts WHERE slug = ?').bind(slug).first();
}

// Safe partial edit of an article: changes ONLY the fields passed, strips
// dashes, refreshes updated_at/updated_by, and (for an already-published post)
// re-mirrors the calendar row. The host writeBlogPost also logged a
// workflow_runs row for the blog-to-calendar-mirror hop — that table is
// host-only, so the mirror here goes through the calendar gateway without the
// workflow ledger entry.
async function patchBlogPostRow(api, slug, patch = {}) {
  const existing = await readBlogPostRow(api, slug);
  if (!existing) throw new Error(`blog post not found: ${slug}`);
  const title = patch.title !== undefined ? stripDashes(patch.title) : existing.title;
  const excerpt = patch.excerpt !== undefined ? stripDashes(patch.excerpt) : existing.excerpt;
  const body = patch.body !== undefined ? stripDashes(patch.body) : existing.body;
  const updatedBy = patch.updated_by || 'nyo';
  const t = now();
  await api.db.prepare(
    'UPDATE plugin_editorial_blog_posts SET title=?, excerpt=?, body=?, updated_at=?, updated_by=? WHERE slug=?',
  ).bind(title, excerpt, body, t, updatedBy, slug).run();
  await api.log('blog_post_updated', { slug, title, actor: updatedBy });
  if (existing.published && existing.published_at) {
    try {
      await api.gateway('calendar', 'upsert', {
        kind: 'blog_publish',
        title,
        description: excerpt,
        starts_at: existing.published_at,
        all_day: true,
        status: existing.published_at <= t ? 'done' : 'confirmed',
        source: 'blog',
        source_ref: slug,
        link_url: `/blog/${slug}`,
        created_by: updatedBy,
        updated_by: updatedBy,
      });
    } catch { /* best-effort — the article edit itself must not be lost */ }
  }
  return readBlogPostRow(api, slug);
}

// ── live/dry-run gate ───────────────────────────────────────────────────────
// LIVE by default. An operator who connected a posting channel, wrote a post
// and scheduled it means to publish it; a silent dry run there is the product
// lying about what it did. The flag remains as a deliberate OFF switch —
// set hottakes.live false to hold everything without unpicking a schedule.
//
// What actually protects against a mistake is unchanged and is not this flag:
// nothing posts without an approved leg, publishing is an explicit operator
// action, and the outbox claim makes a double-send structurally impossible.
// feature_flags is a HOST table — SELECT-only via requires.host_reads.
export async function hotTakesLive(api) {
  try {
    const r = await api.db.prepare('SELECT key, value FROM feature_flags').all();
    const flags = Object.fromEntries((r.results || []).map((x) => [x.key, x.value === 1]));
    return flags['hottakes.live'] !== false;
  } catch {
    // A flag store that cannot be read is not consent to broadcast.
    return false;
  }
}

// The release channels a Hot Take is distributed on. DERIVED from the social
// gateway's connection registry (the single source of truth), narrowed to the
// LinkedIn networks — no separate copy of the channel list lives here. The
// literal below is only the fallback used when the gateway can't be read.
// (async in the plugin port: the registry sits behind api.gateway.)
const RELEASE_CHANNELS_FALLBACK = ['linkedin-company', 'linkedin-personal'];
export async function releaseChannels(api) {
  try {
    const conns = await api.gateway('social', 'connections', {});
    const li = (conns || []).filter((c) => c.network === 'linkedin').map((c) => c.connection);
    return li.length ? li : RELEASE_CHANNELS_FALLBACK;
  } catch {
    return RELEASE_CHANNELS_FALLBACK;
  }
}

// ── row normalizers ─────────────────────────────────────────────────────────
function rowToPackage(row) {
  if (!row) return null;
  const { multi_source_json, brief_json, review_json, ...rest } = row;
  return {
    ...rest,
    pinned: !!row.pinned,
    multi_source: safeJSON(multi_source_json) || [],
    brief: safeJSON(brief_json) || null,
    review: safeJSON(review_json) || null,
  };
}

// ── package CRUD ────────────────────────────────────────────────────────────
export async function listPackages(api, { statuses = null, pinned = null, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (Array.isArray(statuses) && statuses.length) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    args.push(...statuses);
  } else {
    where.push(`status != 'dismissed'`);
  }
  if (pinned === true) where.push('pinned = 1');
  const lim = Math.min(Math.max(1, Number(limit) || 200), 500);
  const sql = `SELECT * FROM plugin_editorial_hot_take_packages WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`;
  args.push(lim);
  const r = await api.db.prepare(sql).bind(...args).all();
  return (r.results || []).map(rowToPackage);
}

export async function readPackage(api, id) {
  const row = await api.db.prepare('SELECT * FROM plugin_editorial_hot_take_packages WHERE id = ?').bind(id).first();
  return rowToPackage(row);
}

export async function findPackageByOrigin(api, originRef) {
  if (originRef == null || originRef === '') return null;
  const row = await api.db.prepare(
    `SELECT * FROM plugin_editorial_hot_take_packages WHERE origin_ref = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT 1`,
  ).bind(String(originRef)).first();
  return rowToPackage(row);
}

export async function createPackage(api, data = {}) {
  const t = now();
  const id = data.id || genId('ht');
  const p = {
    id,
    status: data.status || 'topic',
    title: data.title ?? null,
    summary: data.summary ?? null,
    why_it_matters: data.why_it_matters ?? null,
    source_name: data.source_name ?? null,
    source_url: data.source_url ?? null,
    published_at: data.published_at ?? null,
    origin: data.origin || 'manual',
    origin_ref: data.origin_ref != null ? String(data.origin_ref) : null,
    multi_source_json: data.multi_source ? JSON.stringify(data.multi_source) : (data.multi_source_json ?? null),
    pinned: data.pinned ? 1 : 0,
    take: data.take ?? null,
    believe: data.believe ?? null,
    misunderstood: data.misunderstood ?? null,
    who_cares: data.who_cares ?? null,
    reader_action: data.reader_action ?? null,
    brief_json: data.brief ? JSON.stringify(data.brief) : (data.brief_json ?? null),
    blog_slug: data.blog_slug ?? null,
    headline: data.headline ?? null,
    intro: data.intro ?? null,
    review_json: data.review ? JSON.stringify(data.review) : (data.review_json ?? null),
    company_notes: data.company_notes ?? null,
    author_notes: data.author_notes ?? null,
    website_status: data.website_status || 'not_planned',
    website_url: data.website_url ?? null,
    scheduled_at: data.scheduled_at ?? null,
    actor: data.actor || 'hot-takes',
  };
  await api.db.prepare(
    `INSERT INTO plugin_editorial_hot_take_packages
      (id,status,title,summary,why_it_matters,source_name,source_url,published_at,origin,origin_ref,multi_source_json,pinned,
       take,believe,misunderstood,who_cares,reader_action,brief_json,blog_slug,headline,intro,review_json,company_notes,author_notes,
       website_status,website_url,scheduled_at,actor,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    p.id, p.status, p.title, p.summary, p.why_it_matters, p.source_name, p.source_url, p.published_at, p.origin, p.origin_ref, p.multi_source_json, p.pinned,
    p.take, p.believe, p.misunderstood, p.who_cares, p.reader_action, p.brief_json, p.blog_slug, p.headline, p.intro, p.review_json, p.company_notes, p.author_notes,
    p.website_status, p.website_url, p.scheduled_at, p.actor, t, t,
  ).run();
  await api.log('hottake_topic_added', { id, origin: p.origin, title: p.title, actor: p.actor });
  return readPackage(api, id);
}

// Whitelisted shallow patch. Scalar columns + three JSON-encoded object fields
// (multi_source→multi_source_json, brief→brief_json, review→review_json).
const PATCHABLE = [
  'status', 'title', 'summary', 'why_it_matters', 'source_name', 'source_url', 'published_at', 'origin', 'origin_ref', 'pinned',
  'take', 'believe', 'misunderstood', 'who_cares', 'reader_action', 'blog_slug', 'headline', 'intro', 'company_notes', 'author_notes',
  'website_status', 'website_url', 'scheduled_at',
];

export async function patchPackage(api, id, patch = {}, actor = 'hot-takes') {
  const existing = await readPackage(api, id);
  if (!existing) throw new Error(`hot take ${id} not found`);
  const fields = [];
  const args = [];
  for (const k of PATCHABLE) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = ?`);
      args.push(k === 'pinned' ? (patch[k] ? 1 : 0) : patch[k]);
    }
  }
  if (patch.multi_source !== undefined) { fields.push('multi_source_json = ?'); args.push(patch.multi_source ? JSON.stringify(patch.multi_source) : null); }
  if (patch.brief !== undefined) { fields.push('brief_json = ?'); args.push(patch.brief ? JSON.stringify(patch.brief) : null); }
  if (patch.review !== undefined) { fields.push('review_json = ?'); args.push(patch.review ? JSON.stringify(patch.review) : null); }
  if (!fields.length) return existing;
  fields.push('updated_at = ?');
  args.push(now());
  args.push(id);
  await api.db.prepare(`UPDATE plugin_editorial_hot_take_packages SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run();
  await api.log('hottake_updated', { id, keys: Object.keys(patch), actor });
  return readPackage(api, id);
}

export async function dismissPackage(api, id, actor = 'hot-takes') {
  await api.db.prepare('UPDATE plugin_editorial_hot_take_packages SET status = ?, updated_at = ? WHERE id = ?')
    .bind('dismissed', now(), id).run();
  await api.log('hottake_dismissed', { id, actor });
  return readPackage(api, id);
}

// Pin a topic from the live feed into a durable package (idempotent by origin_ref
// so pinning the same card twice does not create duplicates).
export async function pinTopic(api, data = {}, actor = 'operator') {
  const existing = await findPackageByOrigin(api, data.origin_ref);
  if (existing) {
    if (!existing.pinned) return patchPackage(api, existing.id, { pinned: true }, actor);
    return existing;
  }
  return createPackage(api, { ...data, pinned: 1, status: 'topic', actor });
}

// Manually remove a live-feed topic the operator judged not good enough. The feed
// (topicsOfTheDay) is a live read with nothing of its own to delete, so removal is
// persisted in the package store: an existing package for this card is dismissed;
// otherwise a stub package is created already-dismissed. Either way topicsOfTheDay
// hides any origin_ref carrying a dismissed package, so the card leaves the feed
// and stays gone across refreshes. Idempotent by origin_ref.
export async function dismissTopicCard(api, card = {}, actor = 'operator') {
  const existing = await findPackageByOrigin(api, card.origin_ref);
  if (existing) return dismissPackage(api, existing.id, actor);
  const pkg = await createPackage(api, { ...card, pinned: 0, status: 'dismissed', actor });
  await api.log('hottake_topic_removed', { origin_ref: card.origin_ref ?? null, title: card.title ?? null, actor });
  return pkg;
}

// Adopt a blog draft into the release pipeline. Publications written straight
// into plugin_editorial_blog_posts (Nyo, the digest writer) have no package;
// scheduling or social drafting needs one, so this finds the package already
// linked to the slug or creates a lightweight one (origin 'blog', status
// 'ready' — the editorial spine is already done, the article exists).
// Everything downstream (scheduleRelease, the hourly due-scan, social legs,
// the calendar mirror) then runs through the ONE package machinery — no second
// scheduler for plain blog drafts.
export async function findPackageBySlug(api, slug) {
  if (!slug) return null;
  const row = await api.db.prepare(
    `SELECT * FROM plugin_editorial_hot_take_packages WHERE blog_slug = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT 1`,
  ).bind(String(slug)).first();
  return rowToPackage(row);
}

export async function ensurePackageForSlug(api, slug, actor = 'operator') {
  if (!slug) throw new Error('ensurePackageForSlug: slug required');
  const existing = await findPackageBySlug(api, slug);
  if (existing) return existing;
  const post = await readBlogPostRow(api, slug);
  if (!post) throw new Error(`blog post ${slug} not found`);
  // An already-live article adopts as 'published' (website leg done) so its
  // social legs are immediately schedulable — the due-scan only fires legs of
  // packages whose website is settled.
  const isLive = !!post.published;
  const pkg = await createPackage(api, {
    origin: 'blog', origin_ref: `blog:${slug}`,
    blog_slug: slug,
    title: post.title, headline: post.title, intro: post.excerpt || null,
    status: isLive ? 'published' : 'ready',
    website_status: isLive ? 'published' : 'not_planned',
    website_url: isLive ? blogUrl(slug) : null,
    pinned: 0, actor,
  });
  // Adoption is its own transition (distinct from a topic being added) — make
  // the activity bus say what actually happened.
  await api.log('hottake_draft_adopted', { id: pkg.id, slug, already_live: isLive, actor });
  return pkg;
}

// ── posts (per-leg social distribution) ─────────────────────────────────────
// Legs live in the UNIFIED plugin_editorial_social_posts table (migration 0062
// folded hot_take_posts into it): one store for every social post, package_id
// linking the Hot Takes legs. The column is `content` there, but every reader
// in this file, in the tools and in the HotTakes page speaks `body` — so reads
// alias it back rather than forcing a rename through four layers.
const POST_SELECT = 'SELECT *, content AS body FROM plugin_editorial_social_posts';

export async function listPosts(api, packageId) {
  const r = await api.db.prepare(`${POST_SELECT} WHERE package_id = ? ORDER BY channel ASC`)
    .bind(packageId).all();
  return r.results || [];
}

export async function readPost(api, id) {
  return api.db.prepare(`${POST_SELECT} WHERE id = ?`).bind(id).first();
}

// One row per (package, channel) — create or update in place.
export async function upsertPost(api, { package_id, channel, body, notes, image_url, status, scheduled_at, actor = 'hot-takes' } = {}) {
  if (!package_id || !channel) throw new Error('upsertPost: package_id + channel required');
  const t = now();
  const existing = await api.db.prepare(
    'SELECT id FROM plugin_editorial_social_posts WHERE package_id = ? AND channel = ?',
  ).bind(package_id, channel).first();
  if (existing) {
    await api.db.prepare(
      `UPDATE plugin_editorial_social_posts SET
         content = COALESCE(?, content), notes = COALESCE(?, notes), image_url = COALESCE(?, image_url),
         status = COALESCE(?, status), scheduled_at = COALESCE(?, scheduled_at), actor = ?, updated_at = ?
       WHERE id = ?`,
    ).bind(body ?? null, notes ?? null, image_url ?? null, status ?? null, scheduled_at ?? null, actor, t, existing.id).run();
    await api.log('hottake_post_updated', { id: existing.id, package_id, channel, actor });
    return readPost(api, existing.id);
  }
  // Stamp the article slug on the row when the package already has one, so a
  // leg is findable from the Social module's by-slug listing too.
  const pkg = await api.db.prepare('SELECT blog_slug FROM plugin_editorial_hot_take_packages WHERE id = ?').bind(package_id).first();
  const id = genId('htp');
  await api.db.prepare(
    `INSERT INTO plugin_editorial_social_posts (id, blog_slug, package_id, channel, content, notes, image_url, status, scheduled_at, actor, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, pkg?.blog_slug ?? null, package_id, channel, body ?? '', notes ?? null, image_url ?? null, status || 'draft', scheduled_at ?? null, actor, t, t).run();
  await api.log('hottake_post_updated', { id, package_id, channel, created: true, actor });
  return readPost(api, id);
}

// Patch keys stay the Hot Takes vocabulary; `body` writes the `content` column.
const POST_PATCHABLE = { body: 'content', notes: 'notes', image_url: 'image_url', status: 'status', scheduled_at: 'scheduled_at' };
export async function patchPost(api, id, patch = {}, actor = 'operator') {
  const existing = await readPost(api, id);
  if (!existing) throw new Error(`hot take post ${id} not found`);
  const fields = [];
  const args = [];
  for (const [k, col] of Object.entries(POST_PATCHABLE)) {
    if (patch[k] !== undefined) { fields.push(`${col} = ?`); args.push(patch[k]); }
  }
  if (!fields.length) return existing;
  fields.push('updated_at = ?');
  args.push(now());
  args.push(id);
  await api.db.prepare(`UPDATE plugin_editorial_social_posts SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run();
  await api.log('hottake_post_updated', { id, keys: Object.keys(patch), actor });
  return readPost(api, id);
}

async function listPostsForPackages(api, ids) {
  if (!ids.length) return new Map();
  const placeholders = ids.map(() => '?').join(',');
  const r = await api.db.prepare(
    `${POST_SELECT} WHERE package_id IN (${placeholders})`,
  ).bind(...ids).all();
  const map = new Map();
  for (const row of r.results || []) {
    if (!map.has(row.package_id)) map.set(row.package_id, []);
    map.get(row.package_id).push(row);
  }
  return map;
}

// ── "next action, not just status" ──────────────────────────────────────────
export function computeNextAction(pkg, posts = [], channels = RELEASE_CHANNELS_FALLBACK) {
  if (!pkg) return '';
  switch (pkg.status) {
    case 'topic':   return 'Draft a take';
    case 'take':    return 'Approve the brief';
    case 'brief':   return 'Write the article';
    case 'article': return 'Review the article';
    case 'review': {
      const r = pkg.review || {};
      const openClaims = (r.claims || []).filter((c) => c.status === 'needs_confirmation').length;
      const openFlags = (r.quality_flags || []).filter((f) => !f.resolved).length;
      if (openClaims) return `Confirm ${openClaims} claim${openClaims === 1 ? '' : 's'}`;
      if (openFlags) return `Resolve ${openFlags} issue${openFlags === 1 ? '' : 's'}`;
      return 'Mark ready';
    }
    case 'ready': {
      const withBody = channels.filter((ch) => posts.some((p) => p.channel === ch && p.status !== 'not_planned' && (p.body || '').trim()));
      if (withBody.length < channels.length) {
        const missing = channels.filter((ch) => !withBody.includes(ch) && !posts.some((p) => p.channel === ch && p.status === 'not_planned'));
        if (!missing.length) return 'Schedule the release';
        if (missing.length === channels.length) return 'Prepare social posts';
        return missing[0] === 'linkedin-personal' ? 'Personal post missing' : 'Company post missing';
      }
      return 'Schedule the release';
    }
    case 'scheduled': return 'Awaiting publication';
    case 'published': {
      const legs = posts.filter((p) => p.status !== 'not_planned' && p.status !== 'skipped');
      const done = legs.filter((p) => p.status === 'posted').length;
      if (pkg.website_status !== 'published') return 'Publish the website';
      if (done < legs.length) return `Complete ${legs.length - done} post${legs.length - done === 1 ? '' : 's'}`;
      return 'Complete';
    }
    case 'complete': return 'Complete';
    default: return '';
  }
}

// ── the pipeline view (Publications tab) ────────────────────────────────────
export async function pipelineView(api) {
  const channels = await releaseChannels(api);
  const all = await listPackages(api, { limit: 300 });
  const posts = await listPostsForPackages(api, all.map((p) => p.id));
  const decorate = (p) => ({ ...p, posts: posts.get(p.id) || [], next_action: computeNextAction(p, posts.get(p.id) || [], channels) });
  const groups = { in_flight: [], needs_review: [], ready: [], scheduled: [], published: [] };
  for (const p of all) {
    const d = decorate(p);
    if (['topic', 'take', 'brief'].includes(p.status)) groups.in_flight.push(d);
    else if (['article', 'review'].includes(p.status)) groups.needs_review.push(d);
    else if (p.status === 'ready') groups.ready.push(d);
    else if (p.status === 'scheduled') groups.scheduled.push(d);
    else if (['published', 'complete'].includes(p.status)) groups.published.push(d);
  }
  return groups;
}

// ── inlined feed reads (contract: no lib-to-lib imports) ────────────────────
// These three duplicate the read paths of lib/heartbeat.mjs (topHotTopics,
// topSignals) and lib/digest.mjs (listDigestItems) over the SAME pack tables —
// keep them in sync with those ports.
async function topHotTopicsInline(api, { limit = 6, days = 3, q = '' } = {}) {
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
       ORDER BY heat DESC, created_at DESC LIMIT ?`,
  ).bind(...binds, limit).all();
  return (r.results || []).map((t) => ({ ...t, sources: JSON.parse(t.sources_json || '[]') }));
}

async function topSignalsInline(api, { days = 7, minContent = 55, limit = 12, q = '' } = {}) {
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
      ORDER BY content_score DESC, created_at DESC LIMIT ?`,
  ).bind(...binds, limit).all();
  return r.results || [];
}

async function listDigestItemsInline(api, { limit = 200 } = {}) {
  const r = await api.db.prepare(
    `SELECT * FROM plugin_editorial_digest_items ORDER BY urgency ASC, created_at DESC LIMIT ?`,
  ).bind(limit).all();
  return (r.results || []).map((x) => ({ ...x, meta: safeJSON(x.meta_json) }));
}

// ── Topics of the Day — a LIVE read (not stored) merging the synthesized hot
// Feed sizing. Not editorial policy (that lives in the heartbeat-priorities
// note) — these bound how much work one feed read does.
const MAX_FEED_PAGE = 200;   // largest window the UI can grow to in one request
const MAX_FEED_POOL = 400;   // candidates pulled per origin before ranking
const ALL_TIME_DAYS = 3650;  // "no date floor", expressed in the helpers' unit

// topics + scored signals + the actionable digest feed, deduped by url/title and
// ranked. Pinning one (pinTopic) is what persists a package. Reuses the existing
// heartbeat + digest read paths — never scrapes or mutates them.
//
// BROWSING/SEARCH READS HISTORY WE ALREADY KEEP. The osint topic and signal
// tables have no pruner, so "older topics" is a wider WHERE, not an archive:
// nothing is snapshotted or duplicated. The default view (no history flag, no
// query) keeps the original tight 5/7-day windows, so the daily feed is exactly
// what it was.
//
// WHY `history` GROWS THE WINDOW INSTEAD OF PAGING BY OFFSET. The list is
// recomputed per request, and the default view draws from a deliberately small
// candidate pool (8 topics + 10 signals) that differs from the browse pool — a
// fixed offset would index into a list that shifted under it. Asking for a
// bigger `limit` with `history: true` re-derives one consistent list every time
// instead (and with the LIFO ordering over the fixed browse pool, the visible
// prefix is stable across growth by construction). `offset` is still honoured
// for API callers, but the UI grows the window.
//
// Digest-origin cards are the exception to "we keep everything" — digest items
// are hard-deleted after ~14d, so deep views carry fewer of those. Accepted.
export async function topicsOfTheDay(api, { limit = 12, offset = 0, q = '', history = false } = {}) {
  const size = Math.min(Math.max(1, Number(limit) || 12), MAX_FEED_PAGE);
  const from = Math.max(0, Number(offset) || 0);
  const term = String(q || '').trim();
  const browsing = from > 0 || !!term || !!history;

  // In browse/search mode the pool is FIXED at the cap, deliberately: growing
  // `limit` (or advancing `offset`) then extends ONE stable list instead of
  // re-deriving a different candidate set per request. (Under the old
  // fresh×strong ranking a size-scaled pool measurably reshuffled the visible
  // prefix on every Load more; with today's LIFO ordering the fixed pool keeps
  // it stable by construction.) The default view keeps the small cheap pool.
  const pool = browsing ? MAX_FEED_POOL : Math.min((from + size) * 3 + 20, MAX_FEED_POOL);
  const topicDays = browsing ? ALL_TIME_DAYS : 5;
  const signalDays = browsing ? ALL_TIME_DAYS : 7;

  const out = [];
  const seen = new Set();
  const keyOf = (title, url) => (String(url || '').replace(/[#?].*$/, '').toLowerCase() || String(title || '').toLowerCase().trim());
  const push = (card) => {
    const k = keyOf(card.title, card.source_url);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(card);
  };

  // 1) synthesized hot takes (osint topics) — strongest, lead with these
  try {
    const topics = await topHotTopicsInline(api, { limit: browsing ? pool : 8, days: topicDays, q: term });
    for (const t of topics) {
      const srcs = Array.isArray(t.sources) ? t.sources : [];
      push({
        origin: 'osint_topic', origin_ref: String(t.id),
        title: t.title, summary: t.thesis || '', why_it_matters: t.why_now || '',
        source_name: (srcs[0] && srcs[0].title) || 'Industry pulse',
        source_url: (srcs[0] && srcs[0].url) || null,
        published_at: t.created_at || null, heat: t.heat ?? null,
        multi_source: srcs.length, kind: 'hot_topic',
      });
    }
  } catch { /* topics table may be empty on a fresh db */ }

  // 2) scored industry signals (osint signals)
  try {
    const signals = await topSignalsInline(api, { days: signalDays, minContent: 60, limit: browsing ? pool : 10, q: term });
    for (const s of signals) {
      push({
        origin: 'osint_signal', origin_ref: String(s.id),
        title: s.title, summary: s.summary || '', why_it_matters: s.suggested_angle || '',
        source_name: s.source_name || s.theme || 'Source', source_url: s.url || null,
        published_at: s.published_at || s.created_at || null, heat: s.content_score ?? null,
        multi_source: 0, kind: 'signal',
      });
    }
  } catch { /* */ }

  // 3) the actionable digest feed (insight / content / opportunity items)
  try {
    const items = await listDigestItemsInline(api, { limit: browsing ? MAX_FEED_POOL : 40 });
    const needle = term.toLowerCase();
    for (const it of items) {
      if (!['osint_insight', 'content_opportunity', 'osint_mention', 'opportunity'].includes(it.kind)) continue;
      // The digest read has no `q` param, so this origin is filtered in JS. It
      // is the small, capped, already-expiring one, so a scan is cheaper than
      // widening a shared query every other caller depends on.
      if (needle && !`${it.title || ''} ${it.summary || ''} ${it.suggested_action || ''}`.toLowerCase().includes(needle)) continue;
      push({
        origin: 'digest', origin_ref: String(it.id),
        title: it.title, summary: it.summary || '', why_it_matters: it.suggested_action || '',
        source_name: it.source_label || 'Digest', source_url: it.source_url || null,
        published_at: it.created_at || null, heat: it.urgency ? (4 - it.urgency) * 25 : null,
        multi_source: 0, kind: it.kind,
      });
    }
  } catch { /* */ }

  // Classify each card's origin_ref against the package store. Both classes are
  // then EXCLUDED below: a non-dismissed package is already in the pipeline, and
  // a dismissed one was manually removed by the operator (dismissTopicCard writes
  // a dismissed package for exactly this purpose).
  //
  // Read the package store WHOLE rather than IN(...)-ing one placeholder per
  // candidate. The old form was fine at ~12 candidates but a deep/searched page
  // can carry hundreds, which would blow SQLite's bound-variable limit. This
  // table holds only the operator's own selections (12 rows today), so reading
  // it all and classifying in memory is both cheaper and unbounded-safe.
  const selected = new Set();
  const removed = new Set();
  {
    const r = await api.db.prepare(
      `SELECT origin_ref, status FROM plugin_editorial_hot_take_packages WHERE origin_ref IS NOT NULL`,
    ).all();
    for (const row of r.results || []) {
      if (row.status === 'dismissed') removed.add(String(row.origin_ref));
      else selected.add(String(row.origin_ref));
    }
  }

  // LIFO — newest first, full stop (operator decision 2026-07-24, replacing the
  // earlier fresh×strong hybrid score). Quality still GATES what reaches this
  // feed upstream (heartbeat scoring); this only ORDERS what already cleared
  // that bar. Undated cards sink to the bottom. A timestamp sort over the fixed
  // browse pool is also inherently prefix-stable for Load more.
  const nowMs = now();
  // Drop the operator-removed cards AND the ones already pulled into the
  // pipeline. Excluding selected ones SERVER-side is what keeps each page dense:
  // the client hid them anyway, but filtering after the slice would turn a page
  // of 12 into a page of 3 and read like a broken Load more.
  const ranked = out
    .filter((c) => !removed.has(c.origin_ref) && !selected.has(c.origin_ref))
    .map((c) => ({ ...c, already_selected: false }))
    .sort((a, b) => (b.published_at || 0) - (a.published_at || 0));

  return {
    topics: ranked.slice(from, from + size),
    generated_at: nowMs,
    offset: from,
    limit: size,
    has_more: ranked.length > from + size,
  };
}

// ── article: write via the shared blog pipeline, edit in place ──────────────
// The seed on its own: deterministic prose assembled from the approved take +
// brief + the playbook's Article instruction. No model, no writes — so the
// granular pipeline can hand it to the shared writer as one step, and the fat
// writeArticleFromBrief below keeps using the same text it always did.
export async function buildArticleSeed(api, id) {
  const pkg = await readPackage(api, id);
  if (!pkg) throw new Error(`hot take ${id} not found`);
  if (!pkg.take) throw new Error('no take yet — draft and approve the take first');
  const b = pkg.brief || {};

  const body = [
    `# ${pkg.headline || pkg.title || 'Untitled'}`,
    '',
    `THE ARGUMENT (this is the article's spine — keep it sharp and specific): ${b.argument || pkg.take}`,
    '',
    `Audience: ${b.audience || pkg.who_cares || 'founders and operators'}`,
    `Why now: ${b.why_now || pkg.why_it_matters || ''}`,
    '',
    'Supporting points to develop (3-5 sections, each advancing the argument):',
    ...(Array.isArray(b.points) ? b.points.map((p, i) => `${i + 1}. ${typeof p === 'string' ? p : p?.text || ''}`) : []),
    '',
    b.evidence?.length ? `Evidence available: ${(b.evidence || []).map((e) => (typeof e === 'string' ? e : e?.text || '')).join(' · ')}` : '',
    b.objections?.length ? `Objections to address honestly: ${(b.objections || []).map((o) => (typeof o === 'string' ? o : o?.text || '')).join(' · ')}` : '',
    '',
    `What the company believes: ${pkg.believe || ''}`,
    `What is commonly misunderstood: ${pkg.misunderstood || ''}`,
    `What the reader should do differently: ${pkg.reader_action || b.conclusion || ''}`,
    '',
    pkg.source_url ? `Source under discussion: ${pkg.source_name || ''} — ${pkg.source_url} — ${pkg.summary || ''}` : (pkg.summary || ''),
    pkg.company_notes ? `Company notes: ${pkg.company_notes}` : '',
    pkg.author_notes ? `Author notes: ${pkg.author_notes}` : '',
    '',
    await loadArticleInstruction(api),
  ].filter((l) => l !== null && l !== undefined).join('\n');

  return { id, title: pkg.headline || pkg.title, body };
}

// Attach a written blog draft to the package. Separate from the writing so a
// draft produced by the shared blog chain (or adopted by hand) links the same
// way the in-house writer's output does.
export async function linkArticle(api, id, { slug, title, excerpt } = {}, actor = 'operator') {
  if (!slug) throw new Error('linkArticle: slug required');
  const pkg = await readPackage(api, id);
  if (!pkg) throw new Error(`hot take ${id} not found`);
  // Fall back to the saved post's own headline/excerpt so a caller that only
  // knows the slug still gets a fully-populated package.
  const post = (title === undefined || excerpt === undefined) ? await readBlogPostRow(api, slug).catch(() => null) : null;
  const updated = await patchPackage(api, id, {
    blog_slug: slug,
    headline: title ?? post?.title ?? pkg.headline ?? pkg.title,
    intro: excerpt ?? post?.excerpt ?? null,
    status: 'review',
  }, actor);
  // The legs created before the article existed carry no slug yet.
  await api.db.prepare('UPDATE plugin_editorial_social_posts SET blog_slug = ? WHERE package_id = ? AND blog_slug IS NULL')
    .bind(slug, id).run();
  await api.log('hottake_article_linked', { id, slug, actor });
  return updated;
}

// The heavy article write. `compose` is composeAndSavePost from
// './aeo-writer.mjs', handed in by the calling tool (lib files import
// nothing, so the seam that used to be a dynamic import is now a parameter).
export async function writeArticleFromBrief(api, id, { voice = 'house', actor = 'operator', compose } = {}) {
  const seed = await buildArticleSeed(api, id);

  if (typeof compose !== 'function') {
    throw new Error('writeArticleFromBrief: a { compose } function is required — the calling tool imports composeAndSavePost from ./aeo-writer.mjs and passes it');
  }
  const res = await compose(api, {
    title: seed.title,
    body: seed.body,
    voice,
    published: false,
    actor: `hottake:${actor}`,
  });
  if (!res?.slug) throw new Error('article write returned no slug');

  await linkArticle(api, id, { slug: res.slug, title: res.title || seed.title, excerpt: res.post?.excerpt || null }, actor);
  await api.log('hottake_article_written', { id, slug: res.slug, voice, actor });
  return { ok: true, id, slug: res.slug, title: res.title, featured_image: res.featured_image || null };
}

export async function articleView(api, id) {
  const pkg = await readPackage(api, id);
  if (!pkg) return null;
  const posts = await listPosts(api, id);
  let article = null;
  if (pkg.blog_slug) {
    const row = await readBlogPostRow(api, pkg.blog_slug);
    if (row) {
      article = {
        slug: row.slug, title: row.title, excerpt: row.excerpt, body: row.body,
        tags: safeJSON(row.tags) || [], featured_image_url: row.featured_image_url || null,
        published: !!row.published, published_at: row.published_at || null,
      };
    }
  }
  return { package: pkg, posts, article, next_action: computeNextAction(pkg, posts, await releaseChannels(api)) };
}

export async function saveArticleEdit(api, id, { title, excerpt, body } = {}, actor = 'operator') {
  const pkg = await readPackage(api, id);
  if (!pkg?.blog_slug) throw new Error('no article yet for this package');
  await patchBlogPostRow(api, pkg.blog_slug, {
    ...(title !== undefined ? { title } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(body !== undefined ? { body } : {}),
    updated_by: `hottake:${actor}`,
  });
  if (title !== undefined && title !== pkg.headline) await patchPackage(api, id, { headline: title }, actor);
  await api.log('hottake_article_edited', { id, slug: pkg.blog_slug, actor, keys: Object.keys({ title, excerpt, body }).filter((k) => ({ title, excerpt, body })[k] !== undefined) });
  return articleView(api, id);
}

// ── schedule + release ──────────────────────────────────────────────────────
export async function scheduleRelease(api, id, { website_at, company_at, personal_at } = {}, actor = 'operator') {
  const pkg = await readPackage(api, id);
  if (!pkg) throw new Error(`hot take ${id} not found`);
  const timing = await loadTimingDefaults(api);
  const oldBase = Number(pkg.scheduled_at) || null; // pre-reschedule anchor, for offset preservation
  let base = Number(website_at) || null;
  if (!base) {
    // No explicit time → the next occurrence of the note's default publish hour.
    const d = new Date();
    d.setUTCHours(timing.default_hour_utc ?? 13, 0, 0, 0);
    if (d.getTime() <= now()) d.setUTCDate(d.getUTCDate() + 1);
    base = d.getTime();
  }
  // Three tiers per leg, in order: an EXPLICIT time wins; otherwise a reschedule
  // PRESERVES the leg's current offset from the old base (the operator's chosen
  // "how long after publication" survives a date change instead of being reset);
  // a leg with no time yet falls back to the timing-note defaults.
  const explicitTimes = {
    'linkedin-company': Number(company_at) || null,
    'linkedin-personal': Number(personal_at) || null,
  };
  const defaultTimes = {
    'linkedin-company': base + (timing.company_offset_min ?? 120) * 60000,
    'linkedin-personal': base + (timing.personal_offset_min ?? 3) * 60000,
  };

  await patchPackage(api, id, {
    scheduled_at: base,
    website_status: 'scheduled',
    status: 'scheduled',
  }, actor);

  const posts = await listPosts(api, id);
  const legTimes = {};
  for (const ch of await releaseChannels(api)) {
    const existing = posts.find((p) => p.channel === ch);
    if (existing?.status === 'not_planned' || existing?.status === 'skipped') continue;
    const prevAt = Number(existing?.scheduled_at) || null;
    const preserved = oldBase && prevAt ? base + (prevAt - oldBase) : null;
    legTimes[ch] = explicitTimes[ch] || preserved || defaultTimes[ch] || base;
    // Times are booked here; APPROVAL is not. No status is passed, so an
    // existing leg keeps its state and a new placeholder starts 'draft' — a leg
    // only becomes 'scheduled' (the state the due-scan fires) by an explicit
    // per-post approval: the editor's Approve button or the Social tab's
    // Schedule button. Scheduling the website used to auto-promote text-bearing
    // legs; that made per-post approval meaningless.
    await upsertPost(api, {
      package_id: id, channel: ch,
      scheduled_at: legTimes[ch],
      actor,
    });
  }

  // Calendar mirror for the website leg (idempotent on source+source_ref).
  try {
    await api.gateway('calendar', 'upsert', {
      kind: 'blog_publish',
      title: pkg.headline || pkg.title || pkg.blog_slug || id,
      starts_at: base,
      all_day: false,
      status: 'confirmed',
      source: 'hottake',
      source_ref: id,
      link_url: pkg.blog_slug ? blogUrl(pkg.blog_slug) : null,
      created_by: 'system',
    });
  } catch { /* best-effort */ }

  await api.log('hottake_scheduled', { id, website_at: base, legs: legTimes, actor });
  return articleView(api, id);
}

// Undo a schedule. The package returns to 'ready' (unscheduled), the website
// leg to not_planned, and any leg the scheduler queued goes back to
// ready (has text) / draft (empty). The calendar mirror flips to cancelled.
export async function cancelSchedule(api, id, actor = 'operator') {
  const pkg = await readPackage(api, id);
  if (!pkg) throw new Error(`hot take ${id} not found`);
  if (pkg.status !== 'scheduled') return articleView(api, id); // nothing scheduled — no-op
  await patchPackage(api, id, { status: 'ready', website_status: 'not_planned', scheduled_at: null }, actor);
  const posts = await listPosts(api, id);
  for (const p of posts) {
    // Clear the timing on every leg that hasn't actually gone out — a stale
    // scheduled_at on a cancelled release would keep showing as a planned slot.
    if (!['draft', 'ready', 'scheduled'].includes(p.status) || p.scheduled_at == null) continue;
    await patchPost(api, p.id, {
      ...(p.status === 'scheduled' ? { status: (p.body || '').trim() ? 'ready' : 'draft' } : {}),
      scheduled_at: null,
    }, actor);
  }
  try {
    await api.gateway('calendar', 'upsert', {
      kind: 'blog_publish',
      title: pkg.headline || pkg.title || pkg.blog_slug || id,
      starts_at: pkg.scheduled_at || now(),
      all_day: false,
      status: 'cancelled',
      source: 'hottake',
      source_ref: id,
      link_url: pkg.blog_slug ? blogUrl(pkg.blog_slug) : null,
      created_by: 'system',
    });
  } catch { /* best-effort */ }
  await api.log('hottake_schedule_cancelled', { id, actor });
  return articleView(api, id);
}

// Publish the website leg through the SHARED blog pipeline. social:false —
// Hot Takes owns its own two posts; the Social module's auto-fan-out would
// double-draft into the other queue.
// NOT gated on hottakes.live: publishing to the public site is the same trust
// level as the Blog page's ungated Approve button, and a scheduled publication
// must actually go live at its date. Only the LinkedIn legs respect the flag.
// `publish` is the ported publishBlogPostToProd (lib/publish.mjs), handed in
// by the calling tool: publish(api, slug, { source, ctx, social }).
export async function publishWebsite(api, id, { actor = 'operator', ctx = null, publish } = {}) {
  const pkg = await readPackage(api, id);
  if (!pkg) throw new Error(`hot take ${id} not found`);
  if (!pkg.blog_slug) throw new Error('no article to publish — write it first');
  if (pkg.website_status === 'published') return { ok: true, already: true, url: pkg.website_url };

  if (typeof publish !== 'function') {
    throw new Error('publishWebsite: a { publish } function is required — the calling tool imports publishBlogPostToProd from ./publish.mjs and passes it');
  }
  const r = await publish(api, pkg.blog_slug, { source: 'hottake', ctx, social: false });
  if (r?.ok) {
    await patchPackage(api, id, { website_status: 'published', website_url: r.url, status: 'published' }, actor);
    try {
      await api.gateway('calendar', 'upsert', {
        kind: 'blog_publish', title: pkg.headline || pkg.title || pkg.blog_slug,
        starts_at: now(), all_day: false, status: 'done',
        source: 'hottake', source_ref: id, link_url: r.url, created_by: 'system',
      });
    } catch { /* best-effort */ }
    await api.log('hottake_website_published', { id, slug: pkg.blog_slug, url: r.url, actor });
    await maybeComplete(api, id, actor);
  }
  return { ok: !!r?.ok, ...r };
}

// Post one social leg through the SHARED social gateway (Make webhooks), logged
// to the outbox first — mirrors the social-posts approveAndPush semantics.
export async function postLeg(api, postId, { actor = 'operator' } = {}) {
  const post = await readPost(api, postId);
  if (!post) throw new Error(`hot take post ${postId} not found`);
  if (post.status === 'posted') return { ok: true, already: true, id: postId };
  if (!(post.body || '').trim()) throw new Error('post has no text yet');
  const pkg = await readPackage(api, post.package_id);

  // Prefer the article's CURRENT cover (it may have been generated after the
  // draft) — the gateway hard-requires an image.
  const blog = pkg?.blog_slug ? await readBlogPostRow(api, pkg.blog_slug).catch(() => null) : null;
  const imageUrl = blog?.featured_image_url || post.image_url || '';
  const imageTitle = blog?.title || pkg?.headline || pkg?.title || '';

  const live = await hotTakesLive(api);
  if (!live) {
    await api.log('hottake_dryrun', { action: 'post_leg', id: postId, channel: post.channel, chars: (post.body || '').length, has_image: !!imageUrl, actor });
    return { ok: true, dry_run: true, would: { action: 'post', channel: post.channel, chars: (post.body || '').length, image_url: imageUrl || null } };
  }

  const log = await api.gateway('outbox', 'begin', {
    channel: 'social', kind: post.channel, to_id: post.channel,
    body: post.body,
    payload: { package_id: post.package_id, blog_slug: pkg?.blog_slug || null, image_url: imageUrl || null },
    source: 'hottake', source_ref: post.id,
  });
  try {
    const res = await api.gateway('social', 'post', {
      connection: post.channel,
      content: post.body, imageUrl, imageTitle, altText: imageTitle, imageCaption: imageTitle,
    });
    await api.gateway('outbox', 'sent', { id: log.id, message_id: res?.http ? String(res.http) : null });
    const t = now();
    await api.db.prepare(`UPDATE plugin_editorial_social_posts SET status='posted', posted_at=?, outbox_id=?, error=NULL, updated_at=? WHERE id=?`)
      .bind(t, log.id, t, postId).run();
    await api.log('hottake_post_published', { id: postId, channel: post.channel, package_id: post.package_id, actor });
    try {
      await api.gateway('calendar', 'upsert', {
        kind: 'social_post',
        title: `${post.channel}: ${imageTitle || post.package_id}`,
        starts_at: t, all_day: false, status: 'done',
        source: 'hottake', source_ref: postId,
        link_url: pkg?.website_url || (pkg?.blog_slug ? blogUrl(pkg.blog_slug) : null),
        platform: 'linkedin', body: post.body, created_by: 'system',
      });
    } catch { /* best-effort */ }
    await maybeComplete(api, post.package_id, actor);
    return { ok: true, id: postId, channel: post.channel, outbox_id: log.id };
  } catch (e) {
    await api.gateway('outbox', 'failed', { id: log.id, error: String(e?.message || e) });
    const t = now();
    await api.db.prepare(`UPDATE plugin_editorial_social_posts SET status='failed', error=?, outbox_id=?, updated_at=? WHERE id=?`)
      .bind(String(e?.message || e).slice(0, 2000), log.id, t, postId).run();
    await api.log('hottake_post_failed', { id: postId, channel: post.channel, error: String(e?.message || e).slice(0, 300), actor });
    return { ok: false, id: postId, channel: post.channel, error: String(e?.message || e), outbox_id: log.id };
  }
}

// Flip the package complete once the website + every planned leg is done.
async function maybeComplete(api, packageId, actor = 'system') {
  const pkg = await readPackage(api, packageId);
  if (!pkg || pkg.website_status !== 'published') return;
  const posts = await listPosts(api, packageId);
  const planned = posts.filter((p) => !['not_planned', 'skipped'].includes(p.status));
  const allDone = planned.length > 0 && planned.every((p) => p.status === 'posted');
  const noLegs = planned.length === 0 && posts.length > 0; // everything intentionally skipped
  if ((allDone || noLegs) && pkg.status !== 'complete') {
    await patchPackage(api, packageId, { status: 'complete' }, actor);
    await api.log('hottake_complete', { id: packageId, actor });
  }
}

// ── the hourly due-scan (cron :00 leg) ──────────────────────────────────────
// Due website publishes fire FOR REAL (publishWebsite is ungated); due LinkedIn
// legs still respect the hottakes.live flag (dry-run when off).
// The run_due_releases entry tool passes { publish } through (see
// publishWebsite above); ctx is accepted for signature parity but the plugin
// runtime has no waitUntil to hand it.
export async function runDueReleases(api, { ctx = null, publish } = {}) {
  const t = now();
  const live = await hotTakesLive(api);
  const out = { live, posts_dry_run: !live, website_published: [], posts_sent: [], errors: [] };

  const duePkgs = await api.db.prepare(
    `SELECT id FROM plugin_editorial_hot_take_packages WHERE status = 'scheduled' AND website_status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
  ).bind(t).all();
  for (const row of duePkgs.results || []) {
    try {
      const r = await publishWebsite(api, row.id, { actor: 'hottake-cron', ctx, publish });
      if (r?.dry_run) out.website_published.push({ id: row.id, dry_run: true });
      else if (r?.ok) out.website_published.push({ id: row.id, url: r.url });
      else out.errors.push({ id: row.id, error: r?.error || 'publish failed' });
    } catch (e) {
      out.errors.push({ id: row.id, error: String(e?.message || e) });
    }
  }

  const duePosts = await api.db.prepare(
    `SELECT p.id, p.package_id FROM plugin_editorial_social_posts p
       JOIN plugin_editorial_hot_take_packages k ON k.id = p.package_id
      WHERE p.status = 'scheduled' AND p.scheduled_at IS NOT NULL AND p.scheduled_at <= ?
        AND k.status IN ('scheduled','published','complete')
        AND (k.website_status = 'published' OR k.website_status = 'not_planned')`,
  ).bind(t).all();
  for (const row of duePosts.results || []) {
    try {
      const r = await postLeg(api, row.id, { actor: 'hottake-cron' });
      if (r?.dry_run) out.posts_sent.push({ id: row.id, dry_run: true });
      else if (r?.ok) out.posts_sent.push({ id: row.id });
      else out.errors.push({ id: row.id, error: r?.error || 'post failed' });
    } catch (e) {
      out.errors.push({ id: row.id, error: String(e?.message || e) });
    }
  }
  return out;
}

// The scheduled handler's historical import name for the due-scan entry.
export { runDueReleases as htRunDueReleases };

// ── the Schedule view (30-day grid + attention strip) ───────────────────────
function legState(post, pkgLive, t) {
  if (!post) return { state: 'missing', at: null };
  if (post.status === 'not_planned') return { state: 'not_planned', at: null };
  if (post.status === 'skipped') return { state: 'not_planned', at: null };
  if (post.status === 'posted') return { state: 'done', at: post.posted_at };
  if (post.status === 'failed') return { state: 'overdue', at: post.scheduled_at, error: post.error };
  if (post.scheduled_at) {
    if (post.scheduled_at <= t) return { state: pkgLive ? 'overdue' : 'scheduled', at: post.scheduled_at };
    return { state: 'scheduled', at: post.scheduled_at };
  }
  return { state: (post.body || '').trim() ? 'ready' : 'missing', at: null };
}

export async function scheduleView(api, { days = 30 } = {}) {
  const t = now();
  const channels = await releaseChannels(api);
  const pkgs = await listPackages(api, { statuses: ['ready', 'scheduled', 'published', 'complete'], limit: 300 });
  const postsMap = await listPostsForPackages(api, pkgs.map((p) => p.id));

  const releases = pkgs.map((pkg) => {
    const posts = postsMap.get(pkg.id) || [];
    const website = (() => {
      if (pkg.website_status === 'published') return { state: 'done', at: null, url: pkg.website_url };
      if (pkg.website_status === 'scheduled') {
        return { state: pkg.scheduled_at && pkg.scheduled_at <= t ? 'overdue' : 'scheduled', at: pkg.scheduled_at };
      }
      if (pkg.website_status === 'not_planned' && ['published', 'complete'].includes(pkg.status)) return { state: 'not_planned', at: null };
      return { state: pkg.blog_slug ? 'ready' : 'missing', at: pkg.scheduled_at };
    })();
    const markers = { website };
    for (const ch of channels) {
      markers[ch] = legState(posts.find((p) => p.channel === ch), ['scheduled', 'published', 'complete'].includes(pkg.status), t);
    }
    const legStates = channels.map((ch) => markers[ch].state);
    const anyOverdue = website.state === 'overdue' || legStates.includes('overdue');
    const planned = legStates.filter((s) => s !== 'not_planned');
    const allDone = website.state !== 'overdue' && (website.state === 'done' || website.state === 'not_planned') && planned.every((s) => s === 'done');
    const overall =
      pkg.status === 'complete' || allDone ? 'complete'
      : anyOverdue ? 'overdue'
      : website.state === 'done' ? 'published_incomplete'
      : pkg.status === 'scheduled' ? 'scheduled'
      : 'unscheduled';
    return {
      id: pkg.id, title: pkg.headline || pkg.title, blog_slug: pkg.blog_slug, status: pkg.status,
      scheduled_at: pkg.scheduled_at, website_url: pkg.website_url,
      markers, overall, posts,
      next_action: computeNextAction(pkg, posts, channels),
    };
  });

  // Attention strip: overdue → published-but-incomplete → awaiting review → ready-unscheduled.
  const reviewPkgs = await listPackages(api, { statuses: ['article', 'review'], limit: 50 });
  const attention = [
    ...releases.filter((r) => r.overall === 'overdue').map((r) => ({ kind: 'overdue', id: r.id, title: r.title, note: 'A planned action was not completed on time' })),
    ...releases.filter((r) => r.overall === 'published_incomplete').map((r) => ({ kind: 'incomplete', id: r.id, title: r.title, note: 'Article is live but distribution is missing' })),
    ...reviewPkgs.map((p) => ({ kind: 'review', id: p.id, title: p.headline || p.title, note: 'Waiting for review' })),
    ...releases.filter((r) => r.overall === 'unscheduled').map((r) => ({ kind: 'unscheduled', id: r.id, title: r.title, note: 'Ready — pick a publication date' })),
  ];

  return { releases, attention, live: await hotTakesLive(api), channels, window_days: days, now: t };
}

// ── Approved Sources (shared osint sources + contribution readout) ──────────
export async function listApprovedSources(api) {
  // Inlined listHeartbeatSources (lib/heartbeat.mjs) — same table, same order.
  const srcRows = await api.db.prepare('SELECT * FROM plugin_editorial_osint_sources ORDER BY kind, name').all();
  const sources = srcRows.results || [];
  const t14 = now() - 14 * 86400000;
  let stats = new Map();
  try {
    const r = await api.db.prepare(
      `SELECT source_id,
              MAX(created_at) AS last_signal_at,
              SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS signals_14d,
              SUM(CASE WHEN created_at > ? AND content_score >= 60 THEN 1 ELSE 0 END) AS useful_14d
         FROM plugin_editorial_osint_signals WHERE source_id IS NOT NULL GROUP BY source_id`,
    ).bind(t14, t14).all();
    stats = new Map((r.results || []).map((row) => [row.source_id, row]));
  } catch { /* signals table may be empty */ }
  const dec = (s) => {
    const st = stats.get(s.id) || {};
    return {
      ...s,
      last_signal_at: st.last_signal_at || null,
      signals_14d: st.signals_14d || 0,
      useful_14d: st.useful_14d || 0,
    };
  };
  return {
    channels: sources.filter((s) => s.kind === 'rss').map(dec),
    topics: sources.filter((s) => s.kind !== 'rss').map(dec),
  };
}

// ── search (packages + posts + the editable notes) ──────────────────────────
export async function searchHotTakes(api, { q = '', limit = 30 } = {}) {
  const term = String(q || '').trim();
  if (!term) return { query: '', packages: [], posts: [], notes: [] };
  const like = `%${term.toLowerCase()}%`;
  const lim = Math.min(Math.max(1, Number(limit) || 30), 100);
  const pk = await api.db.prepare(
    `SELECT id, title, headline, status, summary FROM plugin_editorial_hot_take_packages
      WHERE status != 'dismissed' AND (
        LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(headline,'')) LIKE ? OR LOWER(COALESCE(summary,'')) LIKE ?
        OR LOWER(COALESCE(take,'')) LIKE ? OR LOWER(COALESCE(company_notes,'')) LIKE ? OR LOWER(COALESCE(author_notes,'')) LIKE ?)
      ORDER BY updated_at DESC LIMIT ?`,
  ).bind(like, like, like, like, like, like, lim).all();
  const po = await api.db.prepare(
    // Package legs only — the unified table also holds the Blog fan-out's
    // posts, which this search has never covered.
    `SELECT p.id, p.package_id, p.channel, p.status, SUBSTR(COALESCE(p.content,''),1,140) AS snippet
       FROM plugin_editorial_social_posts p WHERE p.package_id IS NOT NULL
        AND (LOWER(COALESCE(p.content,'')) LIKE ? OR LOWER(COALESCE(p.notes,'')) LIKE ?)
      ORDER BY p.updated_at DESC LIMIT ?`,
  ).bind(like, like, lim).all();
  const notes = [];
  for (const slug of [POV_LIBRARY_SLUG, PATTERNS_SLUG]) {
    try {
      const doc = await api.knowledge(slug);
      if (doc?.body && doc.body.toLowerCase().includes(term.toLowerCase())) notes.push({ slug, title: doc.title });
    } catch { /* */ }
  }
  return { query: term, packages: (pk.results || []), posts: (po.results || []), notes };
}

// ── knowledge notes (editable rules — seeded on first read) ─────────────────
// All Hot Takes docs are OWNED by this pack and re-slugged
// 'plugin-editorial-hottakes-*' (RE-SLUG RULE: the leading 'hottakes-' is
// kept). Reads go through api.knowledge, the seed write through
// api.saveKnowledge — never raw SQL on knowledge_docs.
export async function loadHotTakesDoc(api, slug, fallback = { title: slug, body: '' }) {
  try {
    const doc = await api.knowledge(slug);
    if (doc && doc.body) return doc;
  } catch { /* fall through to seed */ }
  try {
    await api.saveKnowledge(slug, { title: fallback.title, body: fallback.body });
    return await api.knowledge(slug);
  } catch {
    return { slug, title: fallback.title, body: fallback.body };
  }
}

// The add-link metadata-extraction prompt lives in an editable knowledge note
// (seeded on first read), not as a literal in the tool — change the note, not code.
const LINK_EXTRACT_DEFAULT = `You extract article metadata. Return ONLY JSON: {"title","source_name","summary","why_it_matters","published_at_iso"}. summary = 1-2 plain sentences on what happened. why_it_matters = one sentence on why the operator's company might care. published_at_iso = ISO 8601 date if determinable, else null. Be faithful to the text; never invent facts.`;
export async function loadLinkExtractPrompt(api) {
  const doc = await loadHotTakesDoc(api, 'plugin-editorial-hottakes-link-extract', {
    title: 'Hot Takes — link extraction prompt',
    body: LINK_EXTRACT_DEFAULT,
  });
  return (doc && doc.body) || LINK_EXTRACT_DEFAULT;
}

export const POV_LIBRARY_SLUG = 'plugin-editorial-hottakes-pov-library';
const POV_LIBRARY_DEFAULT = `# Point-of-View Library

Reusable company positions the take-drafter grounds every Hot Take in. Edit freely — the drafter reads this live.

## Positions
- AI-native beats AI-assisted: bolting AI onto old workflows loses to rebuilding the workflow around the model.
- Distribution is the moat now; production cost is collapsing toward zero.
- Small senior teams that ship beat big teams that coordinate.

## Beliefs
- Opinions earn attention; summaries don't.
- Specific beats comprehensive. One sharp claim per piece.

## Terminology
- "AI-native" — built assuming the model does the work, humans supply judgment.

## Approved statements
- Add your company's approved one-line positioning statements here.
`;
export const loadPovLibrary = (api) => loadHotTakesDoc(api, POV_LIBRARY_SLUG, { title: 'Hot Takes — Point-of-View Library', body: POV_LIBRARY_DEFAULT });

export const PATTERNS_SLUG = 'plugin-editorial-hottakes-article-patterns';
const PATTERNS_DEFAULT = `# Reusable publication patterns

Structures the brief-builder may propose. Guidance, not a straitjacket — never force every article into the same shape.

1. **Event → implication → company view → recommended action.** For industry news.
2. **Common belief → why it is wrong → evidence → better approach.** For contrarian takes.
3. **New development → who it affects → what changes → what to do next.** For product/model launches.
`;
export const loadPatterns = (api) => loadHotTakesDoc(api, PATTERNS_SLUG, { title: 'Hot Takes — publication patterns', body: PATTERNS_DEFAULT });

export const QUALITY_RULES_SLUG = 'plugin-editorial-hottakes-quality-rules';
const QUALITY_RULES_DEFAULT = `# Article quality rules

The review scan flags these weaknesses. The goal is not to "hide AI" — it is an article that is specific, original, sourced, and recognizably written from the company's perspective.

- Generic introductions (throat-clearing, "in today's fast-paced world").
- Repeated ideas across sections.
- Unsupported claims stated as fact.
- Overly broad statements with no named subject.
- Unclear audience — who exactly should care?
- Excessive industry jargon.
- Sections that do not advance the central argument.
- Language that sounds unlike previously approved company writing.

Claim taxonomy: directly_supported (a cited source backs it) · company_experience (we know this from our own work) · opinion (clearly framed as a stance) · unsupported (needs confirmation or removal).
`;
export const loadQualityRules = (api) => loadHotTakesDoc(api, QUALITY_RULES_SLUG, { title: 'Hot Takes — quality rules', body: QUALITY_RULES_DEFAULT });

export const PLAYBOOK_SLUG = 'plugin-editorial-hottakes-playbook';
const PLAYBOOK_DEFAULT = `# Hot Takes playbook

How the take-drafter and brief-builder behave. Edit to change their behavior — no deploy.

## Draft a take
Propose a SPECIFIC, defensible company opinion on the topic — not a neutral summary. Ground it in the Point-of-View Library. Answer four things: what the company believes; what is commonly misunderstood; who should care; what the reader should do differently. One clear argument, no hedging.

## Editorial brief
Before a long article is written: proposed argument, intended audience, why the topic matters now, 3-5 supporting points, evidence available, possible objections, recommended conclusion. Pick the publication pattern that fits (see plugin-editorial-hottakes-article-patterns). The brief exists so no one polishes an article built around the wrong argument.

## Social posts
Company post = the organization's position: composed, confident, no first person singular. Personal post = direct, experiential, first person, one concrete observation — NOT a copy of the company post. Both end with a reason to read the full article. 900-1,300 characters each, no hashtag walls (max 3), no em-dashes.

## Article
Write this as an in-depth opinion piece (1,500+ words): open with the claim, argue it with the points above, use the evidence concretely, address the objections, close with the recommended action. This is a POINT OF VIEW, not a news summary.
`;
export const loadPlaybook = (api) => loadHotTakesDoc(api, PLAYBOOK_SLUG, { title: 'Hot Takes — playbook', body: PLAYBOOK_DEFAULT });

// The article-write instruction appended to the prose seed — the "## Article"
// section of the playbook note (editable), with the seeded default as fallback
// for docs written before the section existed.
const ARTICLE_INSTRUCTION_FALLBACK = 'Write this as an in-depth opinion piece (1,500+ words): open with the claim, argue it with the points above, use the evidence concretely, address the objections, close with the recommended action. This is a POINT OF VIEW, not a news summary.';
async function loadArticleInstruction(api) {
  try {
    const doc = await loadPlaybook(api);
    const m = String(doc.body || '').match(/## Article\s*\n([\s\S]*?)(?=\n## |\s*$)/);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* fall through */ }
  return ARTICLE_INSTRUCTION_FALLBACK;
}

export const TIMING_SLUG = 'plugin-editorial-hottakes-timing';
const TIMING_DEFAULT = `# Release timing defaults

Suggested schedule when the operator picks only a date. Offsets are minutes after the website publish. Edit the JSON block — it is parsed live.

\`\`\`json
{ "default_hour_utc": 13, "company_offset_min": 120, "personal_offset_min": 3 }
\`\`\`
`;
export async function loadTimingDefaults(api) {
  const doc = await loadHotTakesDoc(api, TIMING_SLUG, { title: 'Hot Takes — release timing', body: TIMING_DEFAULT });
  try {
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    if (m) return { default_hour_utc: 13, company_offset_min: 120, personal_offset_min: 3, ...JSON.parse(m[1]) };
  } catch { /* fall through */ }
  return { default_hour_utc: 13, company_offset_min: 120, personal_offset_min: 3 };
}

// ── social identities (who appears as the poster in the LinkedIn previews) ──
// Editable note, not code: rename the company, change the personal headline, or
// point avatar_url at a real photo without touching a file. Keyed by channel so
// future platforms slot in beside the two LinkedIn legs.
export const IDENTITIES_SLUG = 'plugin-editorial-hottakes-social-identities';
const IDENTITIES_FALLBACK = {
  'linkedin-company': { name: 'Your Company', headline: 'Company page', avatar_url: null },
  'linkedin-personal': { name: 'You', headline: 'Founder', avatar_url: null },
};
const IDENTITIES_DEFAULT = `# Hot Takes — social identities

Who appears as the poster in each channel's post preview (the editor's Social
page). Edit the JSON block — it is parsed live. \`avatar_url\` may be any image
URL; when null the preview renders initials.

\`\`\`json
${JSON.stringify(IDENTITIES_FALLBACK, null, 2)}
\`\`\`
`;
export async function loadSocialIdentities(api) {
  const doc = await loadHotTakesDoc(api, IDENTITIES_SLUG, { title: 'Hot Takes — social identities', body: IDENTITIES_DEFAULT });
  try {
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    if (m) {
      const parsed = JSON.parse(m[1]);
      const out = {};
      for (const [ch, dflt] of Object.entries(IDENTITIES_FALLBACK)) {
        const v = parsed[ch] || {};
        out[ch] = {
          name: typeof v.name === 'string' && v.name.trim() ? v.name.trim() : dflt.name,
          headline: typeof v.headline === 'string' ? v.headline : dflt.headline,
          avatar_url: typeof v.avatar_url === 'string' && v.avatar_url.trim() ? v.avatar_url.trim() : null,
        };
      }
      return out;
    }
  } catch { /* fall through to defaults */ }
  return { ...IDENTITIES_FALLBACK };
}

// Seed every Hot Takes knowledge note (called from the notes tool so the
// editors always have something to open).
export async function loadAllHotTakesNotes(api) {
  const [pov, patterns, quality, playbook, timing, identities] = await Promise.all([
    loadPovLibrary(api), loadPatterns(api), loadQualityRules(api), loadPlaybook(api),
    loadHotTakesDoc(api, TIMING_SLUG, { title: 'Hot Takes — release timing', body: TIMING_DEFAULT }),
    loadHotTakesDoc(api, IDENTITIES_SLUG, { title: 'Hot Takes — social identities', body: IDENTITIES_DEFAULT }),
  ]);
  return { pov, patterns, quality, playbook, timing, identities };
}
