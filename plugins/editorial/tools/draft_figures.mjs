// Editorial plugin — draft_figures. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { draftFigures } from './cards-figures.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'draft_figures',
  description: 'Design the set of editorial diagrams for one article, in a single reasoning step: it picks 3-5 templates that match the shapes of the article\'s ideas, anchors each to the sentence it illustrates, and drafts the cover slots. Returns specs to hand to render_figures; renders nothing itself.',
  input_schema: {
    type: 'object',
    properties: {
      blog_slug: { type: 'string', description: 'the post to illustrate (title/excerpt/body are read from it when not passed)' },
      title:     { type: 'string' },
      excerpt:   { type: 'string' },
      body:      { type: 'string', description: 'the article body HTML' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return draftFigures(api, {
    blog_slug: slugArg(input),
    title:   input.title || null,
    excerpt: input.excerpt || null,
    body:    input.body || null,
  });
}
