// Editorial plugin — save_blog_post. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).
//
// Load-bearing guardrail: this tool NEVER publishes — a draft reaches the
// public site only through publish_blog_post, the operator's approval gate.

import { saveBlogPost } from './aeo-writer.mjs';

export const def = {
  name: 'save_blog_post',
  description: 'Save one drafted article to the blog as a DRAFT. Pass the {article} object a drafter produced; pass a slug too to overwrite that exact post, otherwise a fresh unique slug is minted from the title. This never publishes and never changes an existing post\'s published state — publishing is the operator\'s separate approval.',
  input_schema: {
    type: 'object',
    properties: {
      article: {
        type: 'object',
        description: 'the drafted article: {slug, title, excerpt, body_html, tags}',
      },
      slug:         { type: 'string', description: 'overwrite this exact post instead of minting a new slug' },
      published_at: { type: 'number', description: 'ms epoch — preserves an imported stub\'s original date on a first save' },
      actor:        { type: 'string', description: 'who is saving (default system)' },
    },
    required: ['article'],
  },
};

// Only `slug` targets an existing row — never `blog_slug` from the shared
// context, which a non-blog step (a social post carries one) could have put
// there and would silently overwrite the wrong article.
export async function run(api, input) {
  return saveBlogPost(api, {
    article:      input.article,
    slug:         input.slug || null,
    published_at: input.published_at ?? null,
    actor:        input.actor || 'nyo',
  });
}
