// Editorial plugin — draft_visual_brief. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { draftImageBrief } from './cards-figures.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'draft_visual_brief',
  description: 'Draft the AI-illustration brief for one article in a single reasoning step: it picks the light behaviour that makes the article\'s argument visible and returns the finished image prompt in the house visual style.',
  input_schema: {
    type: 'object',
    properties: {
      title:     { type: 'string' },
      excerpt:   { type: 'string' },
      tags:      { type: 'array', items: { type: 'string' } },
      blog_slug: { type: 'string', description: 'read title/excerpt/tags from this post instead' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return draftImageBrief(api, {
    title: input.title || null,
    excerpt: input.excerpt || null,
    tags: Array.isArray(input.tags) ? input.tags : null,
    blog_slug: slugArg(input),
  });
}
