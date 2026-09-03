// Editorial plugin — the Blog surface's data layer.
//
// The host REST routes this page used to call (/api/blog/analytics,
// /api/blog/:slug + /publish + /live-status, /api/social/generate/:slug) are
// gone with the module: a plugin surface drives its OWN plugin's tools through the scoped invoke
// route, so the page, the crons and Nyo all write through the exact same
// verbs and can never diverge. The types travel with the module too — they
// used to live in web/src/lib/api.ts, which the conversion strips of its blog
// section.
//
// Helper names and result shapes match the old shared client, so the page and
// the shared ArticleBits editor read unchanged — only the wire underneath
// moved to the invoke route.

// ─── types (the old lib/api.ts blog section, verbatim) ─────────────────────
export type BlogPost = {
  slug: string;
  title: string;
  excerpt: string | null;
  body: string | null;
  tags: string | null;          // JSON-encoded string[] in DB; parsed below
  published_at: number | null;
  published: number;
  updated_at: number;
  updated_by: string | null;
  views: number;
  unique_visitors: number;
  last_view: number | null;
  avg_scroll: number;           // 0-100
  cta_clicks: number;
};

export type BlogPostWithTags = Omit<BlogPost, 'tags'> & { tags: string[] };

// ─── the public site origin ────────────────────────────────────────────────
// Where this install's public site lives (the site blog posts publish to and
// this surface links out to). No production origin is hardcoded: set
// VITE_PUBLIC_SITE_URL at build time to your site's origin (the build-time
// mirror of the publish config's public_origin). Left empty, the preview
// surfaces show their "no public site connected" state instead of a dead
// link. Inlined from the host's lib/site.ts, which leaves with the module.
export const PUBLIC_SITE_URL: string =
  String(import.meta.env.VITE_PUBLIC_SITE_URL || '').trim().replace(/\/+$/, '');

// ─── the invoke pipe ───────────────────────────────────────────────────────
async function invoke<T>(tool: string, input: unknown): Promise<T> {
  const r = await fetch(`/api/plugins/editorial/invoke/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.result as T;
}

// Tags come JSON-encoded from the DB; normalize to the array shape every
// consumer of BlogPostWithTags expects.
function withTags(p: BlogPost): BlogPostWithTags {
  let tags: string[] = [];
  if (p.tags) { try { const x = JSON.parse(p.tags); if (Array.isArray(x)) tags = x; } catch { /* ignore */ } }
  return { ...p, tags };
}

// Same helper names the page called on the old shared client.
export const api = {
  // blog — analytics-joined list
  listBlogAnalytics: async (publishedOnly = true): Promise<BlogPostWithTags[]> => {
    const r = await invoke<{ posts: BlogPost[] }>('list_blog_analytics', { published_only: publishedOnly });
    return r.posts.map(withTags);
  },

  // Live-edit a post's body/title/excerpt. edit_blog_post patches: only the
  // fields passed change, so published_at is preserved without sending it
  // (the old PUT overwrote the row and needed the full set). Editing a draft
  // keeps it a draft; publishing stays a separate step.
  updateBlogPost: (
    slug: string,
    patch: { title: string; excerpt: string | null; body: string | null; tags: string[]; published: number; published_at: number | null },
  ) =>
    invoke<{ ok: boolean; blog_slug: string; post: { slug: string; title: string; published: boolean } }>(
      'edit_blog_post',
      {
        slug,
        title:     patch.title,
        excerpt:   patch.excerpt,
        body:      patch.body,
        tags:      patch.tags,
        published: !!patch.published,
        actor:     'operator',
      },
    ).then((r) => r.post),

  // Is the post actually served on the public site yet? Polled after publish to
  // flip the UI to "live" once the edge + CDN have caught up.
  blogLiveStatus: (slug: string) =>
    invoke<{ live: boolean; status: number; url: string | null }>('blog_live_status', { slug }),

  // Publish this slug live (edge-rendered from D1; mirror + IndexNow inside).
  // Every attempt logs to the Outbox (channel='blog').
  publishBlogPost: (slug: string, opts: { deploy?: boolean } = {}) =>
    invoke<{
      ok: boolean;          // === live: the edge worker actually serves the post
      slug: string;
      live: boolean;
      url: string;
      prod: BlogPost | null;
      mirrored?: boolean;
      mirror_error?: string | null;
      edge?: { live: boolean; status: number } | null;
      outbox_id: string;
    }>('publish_blog_post', { slug, deploy: opts.deploy !== false, actor: 'operator' }),

  // Delete a blog post from local D1 (draft or published). Does NOT unpublish
  // from prod — for a live post, take it down at the source separately.
  deleteBlogPost: (slug: string) =>
    invoke<{ ok: boolean }>('delete_blog_post', { slug }),

  // Draft the whole social set (LinkedIn company + personal, Facebook) from
  // one article into the Social review queue. ok:false = domain miss (post
  // not found), reported inline rather than thrown — same as the old route.
  generateSocialPosts: (slug: string, force = false) =>
    invoke<{ ok: boolean; drafted?: number; skipped?: boolean; reason?: string }>(
      'generate_social_posts', { slug, force },
    ),
};
