// Editorial plugin — lib/publish.mjs. Blog publish flow, ported from
// workers/api/src/lib/publish.js (contract v2.1 pack lib; imports NOTHING,
// every exported fn takes `api` first).
//
// How posts go live: a blog-edge worker routed on the public site's /blog*
// renders any published post STRAIGHT FROM the same D1 this install writes.
// Publishing is therefore a data operation — flip published=1 on
// plugin_editorial_blog_posts and the post is served within ~60s (edge cache).
// There is NO site rebuild in this path. The honest arbiter is
// verifyLiveOnEdge() — we check that the edge worker actually serves the post
// before reporting success.
//
// Port notes (behavioral deltas from the host original):
// - Config: the host read env vars (PROD_API_URL / BLOG_EDGE_URL /
//   PUBLIC_ORIGIN / INDEXNOW_KEY). Plugins see no env, so the same four keys
//   now live in the operator-editable `plugin-editorial-publish-config`
//   knowledge doc (JSON body, or KEY=value lines). Empty/missing keys keep
//   the matching step OFF, exactly like the empty env vars did.
// - All web I/O goes through api.gateway('web', 'text'|'post_json') — the
//   host original already routed through lib/web-gateway.js, same boundary.
// - Outbox rows go through api.gateway('outbox', 'begin'|'sent'|'failed').
// - The host's social fan-out ran the 'social-drafts-for-article' workflow via
//   the workflow runner (leaving a workflow_runs trail). Plugins cannot invoke
//   host workflows, so the same per-channel draft+save is INLINED below
//   (duplicated from lib/social-posts.mjs per the libs-import-nothing
//   contract); the trail is api.log entries instead of workflow_runs rows.
// - logEvent(kind, actor) → api.log(kind, payload) — the bus kind gains the
//   plugin_editorial_ prefix and the actor becomes plugin:editorial; the
//   original actor rides in the payload.

const PUBLISH_CONFIG_SLUG = 'plugin-editorial-publish-config';

const PUBLISHABLE_BLOG_FIELDS = [
  'title', 'excerpt', 'body', 'tags',
  'published', 'published_at',
  'featured_image_url', 'featured_image_prompt',
  'featured_image_model', 'featured_image_generated_at',
];

const now = () => Date.now();
const uid = () => crypto.randomUUID();

// Duplicated from host lib/db.js stripDashes (pure).
function stripDashes(s) {
  if (s == null) return s;
  return String(s)
    .replace(/\s*—\s*/g, ', ')  // em-dash -> comma + space
    .replace(/\s*–\s*/g, '-');  // en-dash -> hyphen
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── configuration ────────────────────────────────────────────
// All four endpoints come from the plugin-editorial-publish-config doc, EMPTY
// by default. Each external step stays off until the operator configures it:
//   prod_api_url   — production API base for the mirror PUT (dev → prod)
//   blog_edge_url  — the blog-edge worker's direct URL, for the live check
//   public_origin  — the public site origin used in reported/announced URLs
//   indexnow_key   — IndexNow key for search-engine pings
export async function loadPublishConfig(api) {
  let cfg = {};
  try {
    const doc = await api.knowledge(PUBLISH_CONFIG_SLUG);
    const body = String(doc?.body || '').trim();
    if (body) {
      try {
        cfg = JSON.parse(body);
      } catch {
        for (const line of body.split('\n')) {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.+?)\s*$/);
          if (m) cfg[m[1]] = m[2];
        }
      }
    }
  } catch { /* unconfigured — every external step stays off */ }
  const pick = (...keys) => {
    for (const k of keys) {
      const v = cfg && typeof cfg === 'object' ? cfg[k] : null;
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  };
  return {
    prod_api_url:  pick('prod_api_url', 'PROD_API_URL').replace(/\/+$/, ''),
    blog_edge_url: pick('blog_edge_url', 'BLOG_EDGE_URL').replace(/\/+$/, ''),
    public_origin: pick('public_origin', 'PUBLIC_ORIGIN').replace(/\/+$/, ''),
    indexnow_key:  pick('indexnow_key', 'INDEXNOW_KEY'),
  };
}

// Confirm the edge worker serves the post — the ground truth for "live".
// Retries because a just-flipped row can race the first render. ~12s worst case.
export async function verifyLiveOnEdge(api, slug, { attempts = 3 } = {}) {
  const { blog_edge_url: base } = await loadPublishConfig(api);
  if (!base) return { live: false, status: 0, skipped: 'blog_edge_url not configured (plugin-editorial-publish-config)' };
  const url = `${base}/blog/${encodeURIComponent(slug)}/`;
  let last = { live: false, status: 0 };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, i * 4000));
    try {
      const r = await api.gateway('web', 'text', { url, timeout_ms: 8000, header_names: ['x-nyyon-blog-edge'] });
      const rendered = r.headers_out && r.headers_out['x-nyyon-blog-edge'] === 'render';
      const hasPost = r.ok && String(r.text || '').includes(`/blog/${slug}/`);
      last = { live: r.ok && rendered && hasPost, status: r.status, rendered, attempt: i + 1 };
      if (last.live) return last;
    } catch (e) {
      last = { live: false, status: 0, error: String(e?.message || e), attempt: i + 1 };
    }
  }
  return last;
}

// Tell IndexNow-federated engines (Bing/Yandex/Seznam/Naver — Bing feeds
// ChatGPT/Copilot) the URLs changed. Best-effort: never blocks a publish.
// Google doesn't do IndexNow; it rides the (edge-served, always-fresh) sitemap.
export async function pingIndexNow(api, urls) {
  try {
    const { indexnow_key: key, public_origin: origin } = await loadPublishConfig(api);
    // Feature off until both the key and the public origin are configured.
    if (!key || !origin) return { ok: false, skipped: 'indexnow_key / public_origin not configured' };
    const r = await api.gateway('web', 'post_json', {
      url: 'https://api.indexnow.org/indexnow',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: {
        host: new URL(origin).host,
        key,
        keyLocation: `${origin}/${key}.txt`,
        urlList: (urls || []).slice(0, 100),
      },
      timeout_ms: 8000,
    });
    return { ok: r.status === 200 || r.status === 202, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function readLocalBlogPost(api, slug) {
  return api.db.prepare('SELECT * FROM plugin_editorial_blog_posts WHERE slug = ?').bind(slug).first();
}

// Only the publishable fields — server-side timestamps/IDs stay authoritative
// on the receiving side.
function buildPublishPayload(localRow) {
  const out = {};
  for (const k of PUBLISHABLE_BLOG_FIELDS) {
    if (localRow[k] !== undefined) out[k] = localRow[k];
  }
  return out;
}

// ─── social fan-out (inlined from lib/social-posts.mjs) ──────────────────────
// The three channels every published article fans out to. Duplicated here
// because pack lib files import nothing; the drafting instructions are
// byte-identical to social-posts.mjs so the two paths can never drift apart
// in behavior, only in file.
const FANOUT_CHANNELS = [
  { key: 'linkedin-company',  network: 'LinkedIn', voice: 'brand',    label: 'LinkedIn (company page)' },
  { key: 'facebook-company',  network: 'Facebook', voice: 'brand',    label: 'Facebook (company page)' },
  { key: 'linkedin-personal', network: 'LinkedIn', voice: 'personal', label: 'LinkedIn (personal)' },
];

async function draftOneChannel(api, channel, article, voiceBody, styleRules) {
  const isPersonal = channel.voice === 'personal';
  const limit = isPersonal ? 1300 : 1200;
  const system = [
    `You write a single ${channel.network} post that promotes a new article from the company's blog.`,
    `Who is speaking and how they sound comes from the voice guide below.`,
    ``,
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
    `- End by pointing to the article, and put the URL on its own final line.`,
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

// When a post goes live, fan out social drafts (company channels in the brand
// voice, the personal channel in the operator's voice). Fully guarded — social
// drafting must NEVER break a publish. Idempotent: a slug that already has
// social rows drafts nothing (same probe the host workflow's steps used).
async function generateSocialDrafts(api, slug) {
  try {
    const post = await readLocalBlogPost(api, slug);
    if (!post) throw new Error('post not found');

    const existing = await api.db.prepare('SELECT COUNT(*) AS n FROM plugin_editorial_social_posts WHERE blog_slug = ?').bind(slug).first();
    if ((existing?.n || 0) > 0) return; // already fanned out — never duplicate

    const { public_origin: origin } = await loadPublishConfig(api);
    const base = origin ? `${origin}/blog` : '/blog';
    let tags = post.tags;
    if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = tags ? [tags] : []; } }
    const article = {
      title:   post.title,
      excerpt: post.excerpt,
      tags:    Array.isArray(tags) ? tags.join(', ') : (tags || ''),
      url:     `${base}/${slug}`,
      snippet: htmlToText(post.body).slice(0, 1600),
    };
    const image_url = post.featured_image_url || null;

    const brandVoice    = (await api.knowledge('brand-voice').catch(() => null))?.body || '';
    const personalVoice = (await api.knowledge('personal-voice').catch(() => null))?.body || '';
    const styleRules    = (await api.knowledge('writing-style-rules').catch(() => null))?.body || '';

    const results = await Promise.all(FANOUT_CHANNELS.map(async (ch) => {
      try {
        const content = await draftOneChannel(api, ch, article, ch.voice === 'personal' ? personalVoice : brandVoice, styleRules);
        const id = uid();
        const t = now();
        await api.db.prepare(
          `INSERT INTO plugin_editorial_social_posts (id, blog_slug, package_id, channel, status, content, notes, image_url, scheduled_at, actor, blog_title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, slug, null, ch.key, 'draft', content, null, image_url, null, null, article.title || null, t, t).run();
        return { channel: ch.key, ok: true, id };
      } catch (e) {
        return { channel: ch.key, ok: false, error: String(e?.message || e) };
      }
    }));

    const drafted = results.filter((r) => r.ok).length;
    try { await api.log('social_drafted', { slug, made: drafted, source: 'blog-publish' }); } catch { /* never fatal */ }
    if (!drafted) {
      const reason = results.map((r) => r.error).filter(Boolean)[0];
      throw new Error(reason || 'social drafting saved no posts');
    }
  } catch (e) {
    try {
      await api.log('social_gen_failed', { slug, error: String(e?.message || e).slice(0, 300) });
    } catch { /* never fatal */ }
  }
}

// ─── publish: blog post ───────────────────────────────────────
// Flip published=1, mirror (best-effort), then VERIFY the edge serves it and
// announce via IndexNow. `opts.deploy` (default true) means "verify +
// announce" — pass {deploy:false} in batches and verify/announce once at the
// end. `opts.social` (default true) fans out social drafts once live.
export async function publishBlogPostToProd(api, slug, { source = 'operator', deploy = true, ctx = null, social = true } = {}) {
  if (!slug) throw new Error('slug required');

  const cfg = await loadPublishConfig(api);

  // Idempotent flip; keeps an existing published_at, stamps one the first time.
  // In production this alone makes the post live (the edge reads this D1).
  await api.db.prepare(
    `UPDATE plugin_editorial_blog_posts SET published = 1, published_at = COALESCE(published_at, ?) WHERE slug = ?`,
  ).bind(now(), slug).run();

  const row = await readLocalBlogPost(api, slug);
  if (!row) throw new Error(`blog post "${slug}" not found`);

  const payload = buildPublishPayload(row);
  const mirror  = cfg.prod_api_url; // empty = mirror step off
  const postUrl = `${cfg.public_origin}/blog/${slug}/`;

  // Log the attempt first — a network blip still leaves a row.
  const log = await api.gateway('outbox', 'begin', {
    channel:    'blog',
    kind:       'post',
    to_id:      slug,
    to_name:    row.title,
    body:       row.title,
    payload:    { url: postUrl, bytes_body: (row.body || '').length },
    source,
    source_ref: slug,
  });

  // 1. Mirror — BEST-EFFORT, and only when prod_api_url is configured.
  //    Redundant when running in production (same D1); the promotion step
  //    when running on the local dev worker. Either way the verify below is
  //    the arbiter, so never block on this.
  let prodPost = null;
  let mirrorError = null;
  if (mirror) {
    try {
      const r = await api.gateway('web', 'post_json', {
        url: `${mirror}/api/blog/${encodeURIComponent(slug)}`,
        method: 'PUT', body: payload,
      });
      if (!r.ok) throw new Error(`prod PUT ${r.status}: ${String(r.text || '').slice(0, 300)}`);
      try { prodPost = JSON.parse(r.text).post; } catch { /* ignore */ }
    } catch (e) {
      mirrorError = String(e?.message || e);
    }
  }

  // 2. Verify the edge actually serves it, then announce. In batch mode
  //    (deploy:false) the caller verifies + announces once at the end.
  //    With no blog_edge_url configured there is nothing to verify against —
  //    the local flip is the whole publish, so it counts as live.
  const canVerify = !!cfg.blog_edge_url;
  const edge = deploy && canVerify ? await verifyLiveOnEdge(api, slug) : null;
  const live = !deploy || !canVerify || !!edge?.live;

  let indexnow = null;
  if (live) {
    await api.gateway('outbox', 'sent', { id: log.id, message_id: prodPost?.updated_at?.toString() || null });
    try {
      await api.log('blog_post_published', { slug, url: postUrl, source });
    } catch { /* never blocks a publish */ }
    if (deploy) {
      const announce = pingIndexNow(api, [postUrl, `${cfg.public_origin}/blog/`]).then((r) => { indexnow = r; });
      if (ctx?.waitUntil) ctx.waitUntil(announce); else await announce;
    }
    if (social) {
      const gen = generateSocialDrafts(api, slug);
      if (ctx?.waitUntil) ctx.waitUntil(gen); else await gen;
    }
  } else {
    await api.gateway('outbox', 'failed', {
      id: log.id,
      error: `blog-edge is not serving ${postUrl} (status ${edge?.status}${edge?.error ? `, ${edge.error}` : ''}) — check the blog-edge worker + zone routes${mirrorError ? `; mirror also failed: ${mirrorError}` : ''}`,
    });
  }

  return {
    ok:           live,
    slug,
    live,
    url:          postUrl,
    mirrored:     !mirrorError,
    mirror_error: mirrorError,
    edge,
    indexnow,
    prod:         prodPost,
    outbox_id:    log.id,
  };
}

// Convenience: publish many slugs in one go; verify a sample and announce all
// URLs in ONE IndexNow ping at the end (per-post verification would blow the
// subrequest budget on large backfills).
export async function publishBlogPostsToProd(api, slugs, { source = 'operator' } = {}) {
  const results = [];
  for (const slug of slugs) {
    try {
      const r = await publishBlogPostToProd(api, slug, { source, deploy: false, social: false });
      results.push({ slug, ok: true, result: r });
    } catch (e) {
      results.push({ slug, ok: false, error: String(e?.message || e) });
    }
  }
  const okSlugs = results.filter((r) => r.ok).map((r) => r.slug);
  const { public_origin: origin } = await loadPublishConfig(api);
  const edge = okSlugs.length ? await verifyLiveOnEdge(api, okSlugs[okSlugs.length - 1]) : null;
  const indexnow = okSlugs.length
    ? await pingIndexNow(api, [...okSlugs.map((s) => `${origin}/blog/${s}/`), `${origin}/blog/`])
    : null;
  return { results, edge, indexnow };
}
