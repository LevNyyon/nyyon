// publish.js — make a blog post live on the operator's public site and log
// the attempt.
//
// How posts go live: a blog-edge worker routed on the public site's /blog*
// (+ /sitemap.xml + /snapshot/posts.json*) renders any published post
// STRAIGHT FROM the same D1 this worker writes. Publishing is therefore a
// data operation — flip published=1 and the post is served within ~60s
// (edge cache). There is NO site rebuild in this path.
//
// Where this runs matters for the mirror step:
//   - In production: env.DB IS the D1 the edge reads. The flip alone makes
//     the post live; the prod-mirror PUT is a harmless no-op-ish write
//     through the production worker into the same DB.
//   - On the local dev worker: env.DB is the LOCAL D1; the mirror PUT (to a
//     worker bound to the production D1) is what promotes the content.
// Either way, the honest arbiter is verifyLiveOnEdge() — we check that the
// edge worker actually serves the post before reporting success.
//
// NOTE: the live check goes to the edge worker's own direct URL
// (BLOG_EDGE_URL), NOT the public origin — a Worker's subrequest to its own
// zone bypasses Workers routes and would hit the static origin (false "not
// live" for every new post). The direct URL exercises the same code + same D1.
//
// Configuration — all env vars, EMPTY by default. Each external step stays
// off until the operator configures its var:
//   PROD_API_URL   — production API base for the mirror PUT (dev → prod promote)
//   BLOG_EDGE_URL  — the blog-edge worker's direct URL, for the live check
//   PUBLIC_ORIGIN  — the public site origin used in reported/announced URLs
//   INDEXNOW_KEY   — IndexNow key for search-engine pings
//
// Every publish attempt — success, no-op, or failure — is logged to the
// Outbox as a `channel='blog'` row, same audit trail as WhatsApp/LinkedIn.

import { beginSend, markSent, markFailed } from './outbox.js';

const PUBLISHABLE_BLOG_FIELDS = [
  'title', 'excerpt', 'body', 'tags',
  'published', 'published_at',
  'featured_image_url', 'featured_image_prompt',
  'featured_image_model', 'featured_image_generated_at',
];

// Deployment endpoints come from env vars only. An empty value means that
// step (mirror / live-check / announce) is skipped until configured.
function prodApiUrl(env) {
  return String(env.PROD_API_URL || '').replace(/\/+$/, '');
}
function blogEdgeUrl(env) {
  return String(env.BLOG_EDGE_URL || '').replace(/\/+$/, '');
}
function publicOrigin(env) {
  return String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
}

// Confirm the edge worker serves the post — the ground truth for "live".
// Retries because a just-flipped row can race the first render. ~12s worst case.
export async function verifyLiveOnEdge(env, slug, { attempts = 3 } = {}) {
  const base = blogEdgeUrl(env);
  if (!base) return { live: false, status: 0, skipped: 'BLOG_EDGE_URL not configured' };
  const url = `${base}/blog/${encodeURIComponent(slug)}/`;
  let last = { live: false, status: 0 };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, i * 4000));
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const rendered = r.headers.get('x-nyyon-blog-edge') === 'render';
      const html = r.ok ? await r.text() : '';
      const hasPost = html.includes(`/blog/${slug}/`);
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
export async function pingIndexNow(env, urls) {
  try {
    const key = env.INDEXNOW_KEY || '';
    const origin = publicOrigin(env);
    // Feature off until both the key and the public origin are configured.
    if (!key || !origin) return { ok: false, skipped: 'INDEXNOW_KEY / PUBLIC_ORIGIN not configured' };
    // Through the web gateway's post_json mode — the IndexNow ping is a plain
    // public-endpoint POST, and service boundaries live in gateways, not here.
    const { postJson } = await import('./web-gateway.js');
    const r = await postJson(env, {
      url: 'https://api.indexnow.org/indexnow',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: {
        host: new URL(origin).host,
        key,
        keyLocation: `${origin}/${key}.txt`,
        urlList: urls.slice(0, 100),
      },
      timeout_ms: 8000,
    });
    return { ok: r.status === 200 || r.status === 202, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function readLocalBlogPost(env, slug) {
  return env.DB.prepare('SELECT * FROM blog_posts WHERE slug = ?').bind(slug).first();
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

// When a post goes live, fan out social drafts (company channels in the brand
// voice, the personal channel in the operator's voice). Lazy import so
// publish.js stays light. Fully guarded — social drafting must NEVER break a
// publish.
async function generateSocialDrafts(env, slug) {
  try {
    // Run the declarative workflow (draft → save, once per channel) so every
    // publish-triggered fan-out leaves a workflow_runs + step_runs trail.
    // seed first: the workflow row self-provisions in any env (idempotent).
    const { runWorkflow, seedSystemWorkflows } = await import('../workflows/runner.js');
    await seedSystemWorkflows(env);
    const r = await runWorkflow(env, 'social-drafts-for-article', { slug }, { trigger_kind: 'event' });
    if (!r.ok) throw new Error(r.error || `workflow failed at step ${r.failed_step}`);
    // The runner only fails on THROWN steps. The old check read the LAST step's
    // {ok:false} — with the 7-step chain the last step is save_social_post,
    // whose result never carries `ok`, so it could never fire and a fan-out
    // that drafted NOTHING looked successful. Count the saves instead.
    const drafted = (r.results || []).filter((s) => s.tool === 'save_social_post' && s.result?.post).length;
    if (!drafted) {
      const reason = (r.results || []).map((s) => s.result?.reason).filter(Boolean)[0];
      throw new Error(reason || 'social drafting saved no posts');
    }
  } catch (e) {
    try {
      const { logEvent } = await import('./db.js');
      await logEvent(env, { kind: 'social_gen_failed', actor: 'system', payload: { slug, error: String(e?.message || e).slice(0, 300) } });
    } catch { /* never fatal */ }
  }
}

// ─── publish: blog post ───────────────────────────────────────
// Flip published=1, mirror (best-effort), then VERIFY the edge serves it and
// announce via IndexNow. `opts.deploy` (default true) now means "verify +
// announce" — pass {deploy:false} in batches and verify/announce once at the
// end. `opts.social` (default true) fans out social drafts once live.
export async function publishBlogPostToProd(env, slug, { source = 'operator', deploy = true, ctx = null, social = true } = {}) {
  if (!slug) throw new Error('slug required');

  // Idempotent flip; keeps an existing published_at, stamps one the first time.
  // In production this alone makes the post live (the edge reads this D1).
  await env.DB.prepare(
    `UPDATE blog_posts SET published = 1, published_at = COALESCE(published_at, ?) WHERE slug = ?`,
  ).bind(Date.now(), slug).run();

  const row = await readLocalBlogPost(env, slug);
  if (!row) throw new Error(`blog post "${slug}" not found`);

  const payload = buildPublishPayload(row);
  const mirror  = prodApiUrl(env); // empty = mirror step off
  const postUrl = `${publicOrigin(env)}/blog/${slug}/`;

  // Log the attempt first — a network blip still leaves a row.
  const log = await beginSend(env, {
    channel:    'blog',
    kind:       'post',
    to_id:      slug,
    to_name:    row.title,
    body:       row.title,
    payload:    { url: postUrl, bytes_body: (row.body || '').length },
    source,
    source_ref: slug,
  });

  // 1. Mirror — BEST-EFFORT, and only when PROD_API_URL is configured.
  //    Redundant when running in production (same D1); the promotion step
  //    when running on the local dev worker. Either way the verify below is
  //    the arbiter, so never block on this.
  let prodPost = null;
  let mirrorError = null;
  if (mirror) {
    try {
      const r = await fetch(`${mirror}/api/blog/${encodeURIComponent(slug)}`, {
        method:  'PUT',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`prod PUT ${r.status}: ${text.slice(0, 300)}`);
      try { prodPost = JSON.parse(text).post; } catch { /* ignore */ }
    } catch (e) {
      mirrorError = String(e?.message || e);
    }
  }

  // 2. Verify the edge actually serves it, then announce. In batch mode
  //    (deploy:false) the caller verifies + announces once at the end.
  //    With no BLOG_EDGE_URL configured there is nothing to verify against —
  //    the local flip is the whole publish, so it counts as live.
  const canVerify = !!blogEdgeUrl(env);
  const edge = deploy && canVerify ? await verifyLiveOnEdge(env, slug) : null;
  const live = !deploy || !canVerify || !!edge?.live;

  let indexnow = null;
  if (live) {
    await markSent(env, log.id, { message_id: prodPost?.updated_at?.toString() || null });
    try {
      const { logEvent } = await import('./db.js');
      await logEvent(env, { kind: 'blog_post_published', actor: source, payload: { slug, url: postUrl } });
    } catch { /* never blocks a publish */ }
    if (deploy) {
      const announce = pingIndexNow(env, [postUrl, `${publicOrigin(env)}/blog/`]).then((r) => { indexnow = r; });
      if (ctx?.waitUntil) ctx.waitUntil(announce); else await announce;
    }
    if (social) {
      const gen = generateSocialDrafts(env, slug);
      if (ctx?.waitUntil) ctx.waitUntil(gen); else await gen;
    }
  } else {
    await markFailed(env, log.id, new Error(
      `blog-edge is not serving ${postUrl} (status ${edge?.status}${edge?.error ? `, ${edge.error}` : ''}) — check the blog-edge worker + zone routes${mirrorError ? `; mirror also failed: ${mirrorError}` : ''}`,
    ));
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
export async function publishBlogPostsToProd(env, slugs, { source = 'operator' } = {}) {
  const results = [];
  for (const slug of slugs) {
    try {
      const r = await publishBlogPostToProd(env, slug, { source, deploy: false, social: false });
      results.push({ slug, ok: true, result: r });
    } catch (e) {
      results.push({ slug, ok: false, error: String(e?.message || e) });
    }
  }
  const okSlugs = results.filter((r) => r.ok).map((r) => r.slug);
  const origin  = publicOrigin(env);
  const edge = okSlugs.length ? await verifyLiveOnEdge(env, okSlugs[okSlugs.length - 1]) : null;
  const indexnow = okSlugs.length
    ? await pingIndexNow(env, [...okSlugs.map((s) => `${origin}/blog/${s}/`), `${origin}/blog/`])
    : null;
  return { results, edge, indexnow };
}
