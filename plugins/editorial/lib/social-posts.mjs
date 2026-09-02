// Editorial plugin — lib/social-posts.mjs. Auto-drafted social posts from
// published blog articles, ported from workers/api/src/lib/social-posts.js
// (contract v2.1 pack lib; imports NOTHING, every exported fn takes `api`
// first).
//
// Flow:
//   1. A blog post goes live → publish.mjs fans out ONE post per channel
//      (company LinkedIn + company Facebook in brand voice, personal LinkedIn
//      in the operator's personal teaser voice) as `draft` rows. Idempotent —
//      re-publishing never duplicates.
//   2. Operator reviews/edits in the Social module and approves.
//   3. approveAndPush() posts through api.gateway('social','post') (the
//      Make-webhook boundary), logs the send to the Outbox + activity feed,
//      and flips the row to `posted` (or `failed`).
//
// Port notes (behavioral deltas from the host original):
// - social_posts → plugin_editorial_social_posts; blog_posts →
//   plugin_editorial_blog_posts (both plugin-owned).
// - PUBLIC_ORIGIN env var → `plugin-editorial-publish-config` knowledge doc
//   (public_origin key); empty = site-relative /blog/<slug> links, exactly
//   like the unset env var. blogPostUrl/articleFromBlogPost take the RESOLVED
//   base string where the host versions took `env` (call publicBlogBase(api)
//   first).
// - callOpenAIJson → api.gateway('llm','json'); postToConnection →
//   api.gateway('social','post',{connection,...}); listConnections →
//   api.gateway('social','connections') (socialSettings is async now);
//   outbox lib → api.gateway('outbox','begin'|'sent'|'failed');
//   upsertCalendarEvent → api.gateway('calendar','upsert').
// - sendGate's hotTakesLive() lazy import is replaced by the same read
//   inlined: a SELECT on the host feature_flags table (requires.host_reads).
// - logEvent → api.log — kinds gain the plugin_editorial_ prefix, actor
//   becomes plugin:editorial, the original actor rides in the payload.

const PUBLISH_CONFIG_SLUG = 'plugin-editorial-publish-config';

const now = () => Date.now();
const uid = () => crypto.randomUUID();

// Duplicated from host lib/db.js stripDashes (pure).
function stripDashes(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\s*—\s*/g, ', ')  // em-dash -> comma + space
    .replace(/\s*–\s*/g, '-');  // en-dash -> hyphen
}

// The three channels every published article fans out to. `voice` picks which
// guide doc drives the draft; `label` is shown in the UI + outbox.
export const CHANNELS = [
  { key: 'linkedin-company',  network: 'LinkedIn', voice: 'brand',    label: 'LinkedIn (company page)' },
  { key: 'facebook-company',  network: 'Facebook', voice: 'brand',    label: 'Facebook (company page)' },
  { key: 'linkedin-personal', network: 'LinkedIn', voice: 'personal', label: 'LinkedIn (personal)' },
];

export const SOCIAL_CHANNELS = ['linkedin-company', 'linkedin-personal', 'facebook-company'];

// Base for published-article links, from the public_origin key of the
// plugin-editorial-publish-config doc (the operator's public site origin,
// e.g. https://example.com). Deliberately empty until configured — links then
// render as site-relative /blog/<slug> paths instead of pointing at anyone
// else's site.
export async function publicBlogBase(api) {
  let origin = '';
  try {
    const doc = await api.knowledge(PUBLISH_CONFIG_SLUG);
    const body = String(doc?.body || '').trim();
    if (body) {
      let cfg = {};
      try {
        cfg = JSON.parse(body);
      } catch {
        for (const line of body.split('\n')) {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.+?)\s*$/);
          if (m) cfg[m[1]] = m[2];
        }
      }
      origin = String(cfg.public_origin || cfg.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
    }
  } catch { /* unconfigured */ }
  return origin ? `${origin}/blog` : '/blog';
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function readPost(api, slug) {
  return api.db.prepare('SELECT * FROM plugin_editorial_blog_posts WHERE slug = ?').bind(slug).first();
}

// ─── drafting ─────────────────────────────────────────────────
// `sourceKind`: 'blog' (default) — promotes a published article of ours.
//               'news' — reacts to an industry item with the company's POV (no
//               article of ours exists yet; used for Digest-sourced drafts).
async function draftOne(api, channel, article, voiceBody, { sourceKind = 'blog', styleRules = '' } = {}) {
  const isPersonal = channel.voice === 'personal';
  const limit = isPersonal ? 1300 : 1200;
  const system = [
    sourceKind === 'news'
      ? `You write a single ${channel.network} post reacting to an industry news item with the company's point of view.`
      : `You write a single ${channel.network} post that promotes a new article from the company's blog.`,
    `Who is speaking and how they sound comes from the voice guide below.`,
    ``,
    // Hard constraints FIRST and last — the banned-phrase list the operator
    // maintains. A draft that uses any banned phrase (or a variant of the same
    // reveal-tease construction) is INVALID; these override the voice guide.
    styleRules ? `HARD CONSTRAINTS — highest priority, override everything below. A draft that violates ANY of these is invalid and must be rewritten before you return it:\n${String(styleRules)}\n` : '',
    `VOICE GUIDE (write IN this voice — its personality, wit, and rhythm, not just its rules):`,
    (voiceBody || '(no voice doc found — write plainly, concretely, no hype)'),
    ``,
    `RULES:`,
    `- Output ONE post as plain text. No markdown, no headings, no hashtags spam.`,
    isPersonal
      ? `- First person, as the operator. TEASE one or two conclusions from the article, do NOT summarize the whole thing. Humble close.`
      : `- Company voice. Confident and concrete, one clear idea, no hype words.`,
    `- Under ${limit} characters total.`,
    `- No exclamation marks. No em-dashes or en-dashes (use commas or plain hyphens).`,
    sourceKind === 'news'
      ? `- End by citing the source, and put the URL on its own final line.`
      : `- End by pointing to the article, and put the URL on its own final line.`,
    ``,
    `Return JSON: { "post": "the full post text, including the URL on its own last line" }`,
  ].join('\n');

  const prompt = [
    `Article title: ${article.title}`,
    `One-line answer / excerpt: ${article.excerpt || '(none)'}`,
    `Tags: ${article.tags || '(none)'}`,
    `Article URL: ${article.url}`,
    ``,
    `Article body (plain text, for context only — do not copy verbatim):`,
    article.snippet,
  ].join('\n');

  const out = await api.gateway('llm', 'json', { system, prompt });
  const text = stripDashes(String(out?.post || '').trim());
  if (!text) throw new Error('LLM returned an empty post');
  return text;
}

async function insertDraft(api, { blog_slug, blog_title, channel, content, image_url }) {
  return insertSocialPostRow(api, { blog_slug, blog_title, channel, content, image_url });
}

// ─── one row per social post, whatever produced it ────────────
// A Hot Takes leg is just a row with package_id set and blog_slug null until
// its article exists. These narrow writers are what the v2 tools compose; the
// fat generators below sit on top of them.

// `base` is the RESOLVED public blog base (from publicBlogBase(api)); pass
// null/'' for site-relative links. (The host version took `env` here.)
export function blogPostUrl(slug, base = null) { return `${base || '/blog'}/${slug}`; }

// The article shape both the drafter and the queue row want, from a blog row.
// Pass the resolved base so the URL resolves against the configured origin.
export function articleFromBlogPost(post, base = null) {
  if (!post) return null;
  let tags = post.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = tags ? [tags] : []; } }
  return {
    blog_slug: post.slug || null,
    title:     post.title || '',
    url:       post.slug ? blogPostUrl(post.slug, base) : '',
    excerpt:   post.excerpt || null,
    tags:      Array.isArray(tags) ? tags : [],
    body_html: post.body || '',
    image_url: post.featured_image_url || null,
  };
}

export async function insertSocialPostRow(api, {
  blog_slug = null, blog_title = null, package_id = null, channel, content,
  image_url = null, notes = null, scheduled_at = null, status = 'draft', actor = null,
} = {}) {
  const id = uid();
  const t = now();
  await api.db.prepare(
    `INSERT INTO plugin_editorial_social_posts (id, blog_slug, package_id, channel, status, content, notes, image_url, scheduled_at, actor, blog_title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, blog_slug, package_id, channel, status, stripDashes(String(content || '').trim()),
    notes, image_url, scheduled_at, actor, blog_title || null, t, t,
  ).run();
  return id;
}

// The idempotency probe behind "re-publishing never duplicates": the drafter
// skips before paying for an LLM call, the save refuses before adding a row.
export async function hasSocialPostFor(api, { slug = null, package_id = null, channel = null } = {}) {
  const where = []; const args = [];
  if (package_id)  { where.push('package_id = ?'); args.push(package_id); }
  else if (slug)   { where.push('blog_slug = ?');  args.push(slug); }
  else return false;
  if (channel)     { where.push('channel = ?');    args.push(channel); }
  const r = await api.db.prepare(`SELECT COUNT(*) AS n FROM plugin_editorial_social_posts WHERE ${where.join(' AND ')}`).bind(...args).first();
  return (r?.n || 0) > 0;
}

// Find the live (unposted) row for one source+channel — what a redraft replaces.
export async function findUnpostedSocialPost(api, { slug = null, package_id = null, channel } = {}) {
  const where = [`status NOT IN ('posted')`, 'channel = ?']; const args = [channel];
  if (package_id) { where.push('package_id = ?'); args.push(package_id); }
  else if (slug)  { where.push('blog_slug = ?');  args.push(slug); }
  else return null;
  return api.db.prepare(`SELECT * FROM plugin_editorial_social_posts WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 1`).bind(...args).first();
}

// Clear only UNPOSTED rows — a forced redraft must never erase the record of
// what actually shipped.
export async function clearUnpostedSocialPosts(api, { slug = null, package_id = null, channel = null } = {}) {
  const where = [`status IN ('draft','ready','scheduled','failed','skipped')`]; const args = [];
  if (package_id) { where.push('package_id = ?'); args.push(package_id); }
  else if (slug)  { where.push('blog_slug = ?');  args.push(slug); }
  else return { deleted: 0 };
  if (channel)    { where.push('channel = ?');    args.push(channel); }
  const r = await api.db.prepare(`DELETE FROM plugin_editorial_social_posts WHERE ${where.join(' AND ')}`).bind(...args).run();
  return { deleted: r?.meta?.changes ?? 0 };
}

// Insert a queue row, or replace the unposted one that already exists for this
// source+channel. A package leg is unique per (package_id, channel): redrafting
// it must rewrite the leg, never add a second one to the same release.
export async function upsertSocialPost(api, {
  blog_slug = null, blog_title = null, package_id = null, channel, content,
  image_url = null, notes = null, scheduled_at = null, status = 'draft', actor = null,
} = {}) {
  if (!SOCIAL_CHANNELS.includes(channel)) throw new Error(`channel must be one of: ${SOCIAL_CHANNELS.join(', ')}`);
  const body = stripDashes(String(content || '').trim());
  if (!body) throw new Error('content required');

  const existing = package_id ? await findUnpostedSocialPost(api, { package_id, channel }) : null;
  if (existing) {
    await api.db.prepare(
      `UPDATE plugin_editorial_social_posts SET content=?, image_url=COALESCE(?, image_url), notes=COALESCE(?, notes),
              blog_slug=COALESCE(?, blog_slug), blog_title=COALESCE(?, blog_title),
              status=?, actor=?, error=NULL, updated_at=? WHERE id=?`,
    ).bind(body, image_url, notes, blog_slug, blog_title, status, actor, now(), existing.id).run();
    await api.log('social_post_saved', { id: existing.id, channel, package_id, replaced: true, actor: actor || 'system' });
    return readSocialPost(api, existing.id);
  }

  const id = await insertSocialPostRow(api, { blog_slug, blog_title, package_id, channel, content: body, image_url, notes, scheduled_at, status, actor });
  await api.log('social_post_saved', { id, channel, package_id, blog_slug, actor: actor || 'system' });
  return readSocialPost(api, id);
}

// Draft ONE channel's post text with this module's fine-tuned instructions —
// the ONLY exported entry point for outside callers (Hot Takes' distribution
// legs use it), so the instruction assembly can never drift from the blog
// fan-out: same three notes, same hard style-rule constraints, same channel
// rules, same snippet construction, the untouched draftOne underneath.
// `sourceKind` picks which framing the prompt uses: 'blog' promotes one of our
// articles, 'news' reacts to someone else's item with our POV.
export async function draftSocialPostText(api, channelKey, { title, excerpt = null, tags = null, url, bodyHtml = '', sourceKind = 'blog' } = {}) {
  const ch = CHANNELS.find((c) => c.key === channelKey);
  if (!ch) throw new Error(`unknown social channel: ${channelKey}`);
  if (!title || !url) throw new Error('draftSocialPostText: title and url required');
  const article = {
    title,
    excerpt,
    tags: Array.isArray(tags) ? tags.join(', ') : (tags || ''),
    url,
    snippet: htmlToText(String(bodyHtml || '')).slice(0, 1600),
  };
  const [brandVoice, personalVoice, styleRules] = await Promise.all([
    api.knowledge('plugin-editorial-brand-voice').catch(() => null),
    api.knowledge('personal-voice').catch(() => null),
    api.knowledge('writing-style-rules').catch(() => null),
  ]);
  return draftOne(api, ch, article, (ch.voice === 'personal' ? personalVoice : brandVoice)?.body || '', {
    sourceKind,
    styleRules: styleRules?.body || '',
  });
}

// Add a STANDALONE social post — one the operator wrote with Nyo, not derived
// from a blog article of ours. Lands as a 'draft' in the same review queue; the
// synthetic `standalone:` slug keeps it out of the per-article grouping.
export async function createSocialPost(api, { channel, content, title = null } = {}) {
  const ch = String(channel || '').trim();
  if (!SOCIAL_CHANNELS.includes(ch)) throw new Error(`channel must be one of: ${SOCIAL_CHANNELS.join(', ')}`);
  const body = stripDashes(String(content || '').trim());
  if (!body) throw new Error('content required');
  const id = await insertDraft(api, { blog_slug: `standalone:${uid()}`, blog_title: title || 'Standalone post', channel: ch, content: body, image_url: null });
  await api.log('social_post_created', { id, channel: ch, standalone: true });
  return readSocialPost(api, id);
}

// Called by the blog publish hook. Drafts 3 posts for the given slug.
// Idempotent: if the slug already has social rows, does nothing (unless force).
export async function generateSocialPostsForBlog(api, slug, { source = 'blog-publish', force = false } = {}) {
  const post = await readPost(api, slug);
  if (!post) return { ok: false, slug, reason: 'post not found' };

  const existing = await api.db.prepare('SELECT COUNT(*) AS n FROM plugin_editorial_social_posts WHERE blog_slug = ?').bind(slug).first();
  if ((existing?.n || 0) > 0 && !force) {
    return { ok: true, slug, skipped: true, reason: 'already has social posts' };
  }
  if (force) {
    // Clear only unposted rows so we never wipe an audit trail of what shipped.
    await api.db.prepare(`DELETE FROM plugin_editorial_social_posts WHERE blog_slug = ? AND status IN ('draft','failed','skipped')`).bind(slug).run();
  }

  const base = await publicBlogBase(api);
  const article = {
    title:   post.title,
    excerpt: post.excerpt,
    tags:    Array.isArray(post.tags) ? post.tags.join(', ') : (post.tags || ''),
    url:     blogPostUrl(slug, base),
    snippet: htmlToText(post.body).slice(0, 1600),
  };
  const image_url = post.featured_image_url || null;

  const brandVoice    = (await api.knowledge('plugin-editorial-brand-voice').catch(() => null))?.body || '';
  const personalVoice = (await api.knowledge('personal-voice').catch(() => null))?.body || '';
  const styleRules    = (await api.knowledge('writing-style-rules').catch(() => null))?.body || '';

  const results = await Promise.all(CHANNELS.map(async (ch) => {
    try {
      const content = await draftOne(api, ch, article, ch.voice === 'personal' ? personalVoice : brandVoice, { styleRules });
      const id = await insertDraft(api, { blog_slug: slug, blog_title: article.title, channel: ch.key, content, image_url });
      return { channel: ch.key, ok: true, id };
    } catch (e) {
      return { channel: ch.key, ok: false, error: String(e?.message || e) };
    }
  }));

  const made = results.filter((r) => r.ok).length;
  await api.log('social_drafted', { slug, made, source }).catch(() => {});
  return { ok: true, slug, drafted: made, results };
}

// Draft reaction posts for a Digest item (industry news/signal/insight) —
// not tied to a blog post of ours. Reuses the exact same per-channel drafting
// and `draft` rows as generateSocialPostsForBlog, so the result shows up in
// the Social module's normal review/edit/approve/send queue. `blog_slug` is
// set to a synthetic `digest:<id>` key (the column is NOT NULL and the Social
// UI groups by it) — readPost/approveAndPush already handle a slug with no
// matching post gracefully.
export async function generateSocialPostsForDigestItem(api, item, { force = false } = {}) {
  const slug = `digest:${item.id}`;

  const existing = await api.db.prepare('SELECT COUNT(*) AS n FROM plugin_editorial_social_posts WHERE blog_slug = ?').bind(slug).first();
  if ((existing?.n || 0) > 0 && !force) {
    return { ok: true, slug, skipped: true, reason: 'already drafted' };
  }
  if (force) {
    await api.db.prepare(`DELETE FROM plugin_editorial_social_posts WHERE blog_slug = ? AND status IN ('draft','failed','skipped')`).bind(slug).run();
  }

  const article = {
    title:   item.title,
    excerpt: item.summary || '',
    tags:    '',
    url:     item.source_url || '',
    snippet: (item.summary || item.title || '').slice(0, 1600),
  };

  const brandVoice    = (await api.knowledge('plugin-editorial-brand-voice').catch(() => null))?.body || '';
  const personalVoice = (await api.knowledge('personal-voice').catch(() => null))?.body || '';
  const styleRules    = (await api.knowledge('writing-style-rules').catch(() => null))?.body || '';

  const results = await Promise.all(CHANNELS.map(async (ch) => {
    try {
      const content = await draftOne(api, ch, article, ch.voice === 'personal' ? personalVoice : brandVoice, { sourceKind: 'news', styleRules });
      const id = await insertDraft(api, { blog_slug: slug, blog_title: article.title, channel: ch.key, content, image_url: null });
      return { channel: ch.key, ok: true, id };
    } catch (e) {
      return { channel: ch.key, ok: false, error: String(e?.message || e) };
    }
  }));

  const made = results.filter((r) => r.ok).length;
  await api.log('social_drafted', { slug, made, source: 'digest' }).catch(() => {});
  return { ok: true, slug, drafted: made, results };
}

// ─── queue helpers (route layer) ──────────────────────────────
export async function listSocialPosts(api, { status = null, slug = null, package_id = null, limit = 300 } = {}) {
  const where = []; const args = [];
  if (status)     { where.push('status = ?');     args.push(status); }
  if (slug)       { where.push('blog_slug = ?');  args.push(slug); }
  if (package_id) { where.push('package_id = ?'); args.push(package_id); }
  const sql = `SELECT * FROM plugin_editorial_social_posts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  args.push(Math.min(Math.max(parseInt(limit, 10) || 300, 1), 1000));
  const r = await api.db.prepare(sql).bind(...args).all();
  return r.results || [];
}

export async function readSocialPost(api, id) {
  return api.db.prepare('SELECT * FROM plugin_editorial_social_posts WHERE id = ?').bind(id).first();
}

export async function patchSocialPost(api, id, { content }) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('content required');
  await api.db.prepare('UPDATE plugin_editorial_social_posts SET content = ?, updated_at = ? WHERE id = ?')
    .bind(stripDashes(content.trim()), now(), id).run();
  return readSocialPost(api, id);
}

export async function skipSocialPost(api, id) {
  await api.db.prepare(`UPDATE plugin_editorial_social_posts SET status = 'skipped', updated_at = ? WHERE id = ?`).bind(now(), id).run();
  return readSocialPost(api, id);
}

export async function deleteSocialPost(api, id) {
  await api.db.prepare('DELETE FROM plugin_editorial_social_posts WHERE id = ?').bind(id).run();
  return { ok: true, id };
}

// Delete every social post for one article (the "topic"). The Outbox + activity
// + calendar keep the record of anything already posted.
export async function deleteSocialGroup(api, slug) {
  const r = await api.db.prepare('DELETE FROM plugin_editorial_social_posts WHERE blog_slug = ?').bind(slug).run();
  return { ok: true, slug, deleted: r?.meta?.changes ?? null };
}

// ─── release: claim, then send ────────────────────────────────
// The no-duplicate design lives here, in three layers:
//   1. CLAIM — an atomic conditional UPDATE lifts the row out of every unsent
//      state into 'claimed'. Two concurrent approvals cannot both win, so the
//      same post can never be handed to the gateway twice.
//   2. FAIL CLOSED — a crash between claim and send leaves the row 'claimed'.
//      It stays visible to the operator and never re-arms itself: a missed post
//      beats a duplicate post, always.
//   3. NO AUTO-RETRY — the outbox row is stamped channel='social', which the
//      wake-up's auto-retry sweep explicitly skips. Re-sending is an operator
//      decision (a 'failed' row is claimable again, a 'posted' row never is).

// Distribution gate: Hot Takes legs (package_id set) only reach the outside
// world once the operator flips the hottakes.live feature flag; the blog
// fan-out has always been ungated and stays that way. The flag read is a
// host_reads SELECT on feature_flags (the host original lazy-imported
// hotTakesLive from hot-takes.js — same semantics, inlined).
export async function sendGate(api, row) {
  if (!row?.package_id) return { gated: false, live: true };
  let live;
  try {
    const flag = await api.db.prepare(`SELECT key, value FROM feature_flags WHERE key = 'hottakes.live'`).first();
    // Mirror flagsAsObject + hotTakesLive: flags[key] = (value === 1);
    // live = flags['hottakes.live'] !== false — a missing row means live.
    live = flag ? Number(flag.value) === 1 : true;
  } catch {
    // A flag store that cannot be read is not consent to broadcast.
    live = false;
  }
  return { gated: true, live };
}

const CLAIMABLE = ['draft', 'ready', 'scheduled', 'failed'];

// Open the send claim on one post: resolve the CURRENT cover, take the atomic
// claim, and log the attempt to the Outbox. Returns the claim the sender needs.
export async function claimSocialPostSend(api, id, { actor = 'operator' } = {}) {
  const row = await readSocialPost(api, id);
  if (!row) throw new Error('social post not found');
  if (row.status === 'posted') throw new Error(`already posted (${id})`);
  if (!(row.content || '').trim()) throw new Error('post has no text yet');

  const ch = CHANNELS.find((c) => c.key === row.channel);
  const post = row.blog_slug ? await readPost(api, row.blog_slug).catch(() => null) : null;
  const imageTitle = post?.title || row.blog_title || '';
  // Prefer the post's CURRENT cover over whatever was on the row at draft
  // time. A draft created before the cover existed would otherwise carry a
  // stale null forever, even after a cover gets generated later (the
  // 2026-07-09 incident: the post had a cover by the time this was approved,
  // but the row still held the null captured at draft time).
  const imageUrl = post?.featured_image_url || row.image_url || '';

  const t = now();
  const claim = await api.db.prepare(
    `UPDATE plugin_editorial_social_posts SET status='claimed', image_url=?, blog_title=COALESCE(blog_title, ?), actor=?, error=NULL, updated_at=?
      WHERE id=? AND status IN (${CLAIMABLE.map(() => '?').join(',')})`,
  ).bind(imageUrl || null, imageTitle || null, actor, t, id, ...CLAIMABLE).run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    const fresh = await readSocialPost(api, id);
    throw new Error(`cannot claim ${id} for sending — it is '${fresh?.status || 'gone'}'`);
  }

  const log = await api.gateway('outbox', 'begin', {
    channel:    'social',
    kind:       row.channel,                     // linkedin-company | ...
    to_id:      row.channel,
    to_name:    ch?.label || row.channel,
    body:       row.content,
    payload:    { blog_slug: row.blog_slug, package_id: row.package_id, image_url: imageUrl || null },
    source:     'social',
    source_ref: row.blog_slug || row.package_id || id,
  });
  await api.db.prepare('UPDATE plugin_editorial_social_posts SET outbox_id=?, updated_at=? WHERE id=?').bind(log.id, now(), id).run();
  await api.log('social_post_claimed', { id, channel: row.channel, outbox_id: log.id, actor }).catch(() => {});

  return {
    id, channel: row.channel, content: row.content,
    image_url: imageUrl || null, image_title: imageTitle, outbox_id: log.id,
  };
}

// Send a CLAIMED post through its connection and close the claim. Refuses
// anything that is not holding an open claim — that refusal is the guarantee.
export async function sendClaimedSocialPost(api, id, { actor = 'operator' } = {}) {
  const row = await readSocialPost(api, id);
  if (!row) throw new Error('social post not found');
  if (row.status === 'posted') throw new Error(`already posted (${id})`);
  if (row.status !== 'claimed' || !row.outbox_id) {
    throw new Error(`post ${id} holds no send claim (status '${row.status}') — approve it first`);
  }

  const ch = CHANNELS.find((c) => c.key === row.channel);
  const imageUrl = row.image_url || '';
  // The claim already resolved and stored the current cover + title; re-read the
  // article only to catch a title edited between claim and send.
  const post = row.blog_slug ? await readPost(api, row.blog_slug).catch(() => null) : null;
  const imageTitle = post?.title || row.blog_title || '';
  const fail = async (e) => {
    await api.gateway('outbox', 'failed', { id: row.outbox_id, error: String(e?.message || e).slice(0, 2000) });
    const t = now();
    await api.db.prepare(`UPDATE plugin_editorial_social_posts SET status='failed', error=?, updated_at=? WHERE id=?`)
      .bind(String(e?.message || e).slice(0, 2000), t, id).run();
    await api.log('social_failed', { id, channel: row.channel, slug: row.blog_slug, error: String(e?.message || e).slice(0, 300), actor }).catch(() => {});
    return { ok: false, id, channel: row.channel, error: String(e?.message || e), outbox_id: row.outbox_id };
  };

  // The Make scenarios cannot complete a post without an image (2026-07-09
  // incident: they answer 200 and then silently do nothing). Refuse here,
  // before the gateway, so the operator sees a real failure to fix.
  if (!imageUrl) return fail(new Error(`no image_url — ${row.channel} cannot post without one`));

  try {
    const res = await api.gateway('social', 'post', {
      connection:   row.channel,
      content:      row.content,
      imageUrl,
      imageTitle,
      altText:      imageTitle,
      imageCaption: imageTitle,
    });
    await api.gateway('outbox', 'sent', { id: row.outbox_id, message_id: res?.http ? String(res.http) : null });
    const t = now();
    await api.db.prepare(`UPDATE plugin_editorial_social_posts SET status='posted', posted_at=?, error=NULL, updated_at=? WHERE id=?`)
      .bind(t, t, id).run();
    await api.log('social_posted', { id, channel: row.channel, slug: row.blog_slug, package_id: row.package_id, http: res?.http, actor }).catch(() => {});
    // Mirror the release onto the calendar (one event per social post). Its own
    // try/catch so a calendar hiccup never flips a successful send to failed.
    try {
      const base = await publicBlogBase(api);
      await api.gateway('calendar', 'upsert', {
        kind:        'social_post',
        title:       `${ch?.label || row.channel}: ${row.blog_title || row.blog_slug || row.package_id || id}`,
        description: (row.content || '').slice(0, 200),
        starts_at:   t,
        all_day:     false,
        status:      'done',
        source:      'social',
        source_ref:  id,
        link_url:    row.blog_slug ? blogPostUrl(row.blog_slug, base) : null,
        platform:    ch?.network || null,
        body:        row.content,
        created_by:  'system',
      });
    } catch { /* best-effort */ }
    return { ok: true, id, channel: row.channel, outbox_id: row.outbox_id, result: res };
  } catch (e) {
    return fail(e);
  }
}

// The original one-shot release, kept for the callers that still expect it.
// It is now literally claim-then-send, so there is exactly ONE send path and
// no way to bypass the claim.
export async function approveAndPush(api, id, { actor = 'operator' } = {}) {
  await claimSocialPostSend(api, id, { actor });
  return sendClaimedSocialPost(api, id, { actor });
}

// ─── settings tab: which gateways are connected ───────────────
// (Async in the plugin — the connection list now crosses the social gateway.)
export async function socialSettings(api) {
  // Only the three Make-webhook connections this module posts through.
  const keys = new Set(CHANNELS.map((c) => c.key));
  const conns = await api.gateway('social', 'connections');
  return (Array.isArray(conns) ? conns : []).filter((c) => keys.has(c.connection));
}
