// Editorial plugin — draft_hottake_social. Surface entry point for the old
// POST /api/hot-takes/packages/:id/draft-social and
// POST /api/hot-takes/blog/:slug/draft-social routes, which drafted the
// LinkedIn legs with the granular host pair (draft_social_post +
// save_social_post). Same flow on the pack's shared social lib: the article's
// fields feed the fine-tuned channel drafter, and the upsert REPLACES the
// package+channel's existing unposted leg — which is what makes the Redraft
// button re-runnable without duplicating legs.

import { readPackage, ensurePackageForSlug } from './hot-takes.mjs';
import { readBlogPost } from './blog-db.mjs';
import { articleFromBlogPost, publicBlogBase, draftSocialPostText, upsertSocialPost } from './social-posts.mjs';

const LEG_CHANNELS = ['linkedin-company', 'linkedin-personal'];

export const def = {
  name: 'draft_hottake_social',
  description: 'Draft a publication\'s LinkedIn legs (company + personal) from its written article. Pass the package id, or a blog slug (a plain draft is adopted into the pipeline first). Pass channel to redraft ONE leg. Redrafting replaces the unposted leg in place — never duplicates.',
  input_schema: {
    type: 'object',
    properties: {
      id:      { type: 'string', description: 'package id' },
      slug:    { type: 'string', description: 'blog slug — used when there is no package yet' },
      channel: { type: 'string', enum: LEG_CHANNELS, description: 'narrow to a single-leg redraft' },
    },
    required: [],
  },
};

export async function run(api, input) {
  const actor = input?.actor || 'operator';
  let pkg = input?.id ? await readPackage(api, input.id) : null;
  const bySlug = !pkg && input?.slug;
  if (bySlug) pkg = await ensurePackageForSlug(api, input.slug, actor);
  if (!pkg) return { error: input?.id ? 'not found' : 'pass id or slug' };
  if (!pkg.blog_slug) return { error: 'package has no article yet' };

  const post = await readBlogPost(api, pkg.blog_slug);
  if (!post) return { error: `no article to draft from (slug ${pkg.blog_slug})` };

  const base = await publicBlogBase(api);
  const article = articleFromBlogPost(post, base);
  const channels = input?.channel ? [input.channel] : LEG_CHANNELS;
  const posts = [];
  for (const channel of channels) {
    let content = null;
    try {
      content = await draftSocialPostText(api, channel, {
        title: article.title, excerpt: article.excerpt, tags: article.tags,
        url: article.url, bodyHtml: article.body_html, sourceKind: 'blog',
      });
    } catch { /* one channel failing must not lose the other */ }
    if (!content) continue;
    const saved = await upsertSocialPost(api, {
      blog_slug: pkg.blog_slug, blog_title: article.title, package_id: pkg.id,
      channel, content, actor,
    });
    // Readers of these rows speak `body` (the Hot Takes vocabulary); the
    // unified store's column is `content` — alias it on the way out.
    if (saved) posts.push({ ...saved, body: saved.body ?? saved.content ?? null });
  }
  return bySlug ? { posts, package_id: pkg.id } : { posts };
}
