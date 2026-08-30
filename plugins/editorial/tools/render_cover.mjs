// Editorial plugin — render_cover. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first). Pixel work happens in the
// host render gateway; the lib keeps only the orchestration.

import { renderCover } from './cards-figures.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'render_cover',
  description: 'Render the article\'s hero cover PNG in the brand template and store it at a fresh cache-busted URL. Reliable by design: no AI image model, no API key, and it falls back to deterministic slots from the title and excerpt when no drafted cover is given. Pass the result to set_featured_image.',
  input_schema: {
    type: 'object',
    properties: {
      blog_slug: { type: 'string' },
      title:     { type: 'string' },
      excerpt:   { type: 'string' },
      cover:     { type: 'object', description: 'optional {kicker, highlight, sub} from draft_cover or draft_figures' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return renderCover(api, {
    blog_slug: slugArg(input),
    title: input.title || null,
    excerpt: input.excerpt || null,
    cover: input.cover || null,
  });
}
