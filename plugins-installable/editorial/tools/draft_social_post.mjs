// Editorial plugin — draft_social_post. Ported verbatim from the host social
// tools (workers/api/src/tools/social.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { SOCIAL_CHANNELS, articleFromBlogPost, blogPostUrl, draftSocialPostText, hasSocialPostFor } from './social-posts.mjs';

// The article a draft is written from. Explicit fields win; otherwise we read
// the blog row read_blog_post put on the context, or the `article` a previous
// draft step already resolved (so step 4 of a fan-out does not depend on a
// `post` key that step 3's save has since overwritten). Inlined per file —
// pack contract. Base-less blogPostUrl gives the same site-relative /blog/<slug>
// fallback the host tool produced with no env.
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
  name: 'draft_social_post',
  description: "Write ONE channel's post text in that channel's voice (brand for the company pages, the operator's personal voice for linkedin-personal), under the operator's style rules. Pass source_kind 'blog' (default) to promote one of our articles, 'news' to react to someone else's item with our point of view. Drafts only — nothing is saved or published. With a slug, it skips a channel that already has a post unless force is true.",
  input_schema: {
    type: 'object',
    properties: {
      channel:     { type: 'string', enum: ['linkedin-company', 'linkedin-personal', 'facebook-company'] },
      title:       { type: 'string', description: 'article or news item headline' },
      url:         { type: 'string', description: 'the link the post points at' },
      excerpt:     { type: 'string' },
      tags:        { type: 'array', items: { type: 'string' } },
      body_html:   { type: 'string', description: 'article body for context (HTML or text)' },
      source_kind: { type: 'string', enum: ['blog', 'news'], description: "'blog' promotes our article, 'news' reacts to an industry item" },
      slug:        { type: 'string', description: 'blog slug — fills title/url from the context and enables the already-drafted check' },
      package_id:  { type: 'string', description: 'Hot Takes package — a leg of that release' },
      force:       { type: 'boolean', description: 'redraft even if this channel already has a post' },
    },
    required: ['channel'],
  },
};

export async function run(api, input) {
  const channel = input?.channel;
  if (!SOCIAL_CHANNELS.includes(channel)) throw new Error(`channel must be one of: ${SOCIAL_CHANNELS.join(', ')}`);
  const article = resolveArticle(input);
  const packageId = input?.package_id || null;

  // Idempotency, cheapest first: a channel that already has a post is not
  // redrafted (and costs no LLM call) unless the operator forces it. A
  // package leg is always a redraft — save_social_post replaces it in place.
  if (!input?.force && !packageId && article.blog_slug
    && await hasSocialPostFor(api, { slug: article.blog_slug, channel })) {
    return { channel, content: null, skipped: true, reason: 'already drafted for this channel', article };
  }
  if (!article.title || !article.url) {
    return { channel, content: null, skipped: true, reason: 'no title/url to write from', article };
  }

  const content = await draftSocialPostText(api, channel, {
    title:      article.title,
    excerpt:    article.excerpt,
    tags:       article.tags,
    url:        article.url,
    bodyHtml:   article.body_html,
    sourceKind: input?.source_kind === 'news' ? 'news' : 'blog',
  });
  return { channel, content, article, package_id: packageId };
}
