// Editorial plugin — draft_card. Ported verbatim from the host social tools
// (workers/api/src/tools/social.js); env → api, shared code in the pack's
// parallel lib (same function names, api first). The template menu in the
// description is the SOCIAL_CARD_TEMPLATES list, inlined as a literal so the
// embedded def is byte-identical to the original's computed string.

import { draftCardSlots } from './cards-figures.mjs';
import { articleFromBlogPost, blogPostUrl } from './social-posts.mjs';

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
    image_url: input?.image_url ?? base.image_url ?? null,
  };
}

export const def = {
  name: 'draft_card',
  description: 'Pick the share-card template that fits the article and write its slot text (one cheap LLM step). Templates: split, statement, checklist, flow — split for a contrast, statement for one sharp claim, checklist for criteria, flow for a process. Pass template to force one, or slots to dictate the exact wording and skip the drafting entirely.',
  input_schema: {
    type: 'object',
    properties: {
      title:    { type: 'string', description: 'article title, or a custom line' },
      excerpt:  { type: 'string' },
      tags:     { type: 'array', items: { type: 'string' } },
      template: { type: 'string', enum: ['split', 'statement', 'checklist', 'flow'], description: 'force a template; omit to let the drafter pick' },
      slots:    { type: 'object', description: 'exact slot text — skips the drafter; must respect the template char limits' },
    },
    required: [],
  },
};

export async function run(api, input) {
  const article = resolveArticle(input);
  const title = article.title;
  if (!title) throw new Error('draft_card: title required (pass title, or read the blog post first)');
  if (input?.slots && Object.keys(input.slots).length) {
    return { template: input?.template || 'statement', slots: input.slots };
  }
  return draftCardSlots(api, {
    title,
    excerpt:  article.excerpt || '',
    tags:     article.tags || [],
    template: input?.template || null,
  });
}
