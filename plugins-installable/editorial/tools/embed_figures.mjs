// Editorial plugin — embed_figures. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { embedFiguresInPost } from './cards-figures.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'embed_figures',
  description: 'Place rendered figures into the post body at their anchor sentences. Any figures from a previous run are stripped first, so re-running refreshes the illustrations instead of stacking duplicates.',
  input_schema: {
    type: 'object',
    properties: {
      blog_slug: { type: 'string' },
      figures:   { type: 'array', description: 'from render_figures' },
    },
    required: ['figures'],
  },
};

export async function run(api, input) {
  return embedFiguresInPost(api, {
    blog_slug: slugArg(input),
    figures: input.figures,
    actor: input.actor || 'nyo',
  });
}
