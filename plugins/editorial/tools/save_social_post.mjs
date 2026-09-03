// Editorial plugin — save_social_post. Ported verbatim from the host social
// tools (workers/api/src/tools/social.js); env → api, shared code in the
// pack's parallel lib (same function names, api first). uid inlined
// (crypto.randomUUID, same as the host util).

import { articleFromBlogPost, blogPostUrl, clearUnpostedSocialPosts, hasSocialPostFor, upsertSocialPost } from './social-posts.mjs';

const uid = () => crypto.randomUUID();

// The article a draft is written from. Explicit fields win; otherwise we read
// the blog row read_blog_post put on the context, or the `article` a previous
// draft step already resolved. Inlined per file — pack contract.
function resolveArticle(input) {
  const fromPost = input?.post && !input.post.channel ? articleFromBlogPost(input.post) : null;
  const base = input?.article || fromPost || {};
  const slug = input?.slug || base.blog_slug || null;
  return {
    blog_slug: slug,
    title:     input?.title     ?? base.title     ?? '',
    url:       input?.url       ?? base.url       ?? (slug ? blogPostUrl(slug) : ''),
    excerpt:   input?.excerpt   ?? base.excerpt   ?? null,
    tags:      input?.tags      ?? base.tags      ?? null,
    body_html: input?.body_html ?? base.body_html ?? '',
  };
}

export const def = {
  name: 'save_social_post',
  description: "Put one post into the review queue as a 'draft'. NEVER publishes: the operator approves it separately. Pass a slug for a blog fan-out row, a package_id for a Hot Takes release leg (which replaces that leg's previous draft), or neither for a standalone post written with the operator. Returns the row and its id.",
  input_schema: {
    type: 'object',
    properties: {
      channel:    { type: 'string', enum: ['linkedin-company', 'linkedin-personal', 'facebook-company'] },
      content:    { type: 'string', description: 'the full post text' },
      slug:       { type: 'string', description: 'source blog slug — omit for a standalone post' },
      title:      { type: 'string', description: 'label shown in the queue' },
      package_id: { type: 'string', description: 'Hot Takes package this leg belongs to' },
      notes:      { type: 'string', description: 'operator note kept alongside the draft' },
      force:      { type: 'boolean', description: 'replace the unposted rows for this slug + channel first' },
    },
    required: ['channel', 'content'],
  },
};

export async function run(api, input) {
  const channel = input?.channel;
  const content = String(input?.content || '').trim();
  const article = resolveArticle(input);
  const packageId = input?.package_id || null;
  // A skipped draft threads through as content:null — record the skip
  // instead of saving whatever text the previous channel left on the ctx.
  if (!content) return { skipped: true, reason: 'no content to save' };

  const slug = input?.slug || article.blog_slug || (packageId ? null : `standalone:${uid()}`);
  if (input?.force) await clearUnpostedSocialPosts(api, { slug, package_id: packageId, channel });
  else if (!packageId && slug && await hasSocialPostFor(api, { slug, channel })) {
    return { skipped: true, reason: 'this channel already has a post for that source' };
  }

  const post = await upsertSocialPost(api, {
    blog_slug:  slug,
    blog_title: input?.title || article.title || null,
    package_id: packageId,
    channel,
    content,
    notes:      input?.notes || null,
    actor:      input?.actor || 'nyo',
  });
  return { post, id: post.id };
}
