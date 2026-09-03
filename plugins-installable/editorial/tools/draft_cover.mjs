// Editorial plugin — draft_cover. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { draftCover } from './cards-figures.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'draft_cover',
  description: 'Draft the three hero slots for an article cover (kicker, the highlighted word from the title, and the standfirst) in one cheap reasoning step. Use it when refreshing only the cover; draft_figures already returns these when it runs.',
  input_schema: {
    type: 'object',
    properties: {
      title:     { type: 'string' },
      excerpt:   { type: 'string' },
      blog_slug: { type: 'string', description: 'read title + excerpt from this post instead' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return draftCover(api, {
    title: input.title || null,
    excerpt: input.excerpt || null,
    blog_slug: slugArg(input),
  });
}
