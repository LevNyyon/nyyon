// Editorial plugin — set_featured_image. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { setFeaturedImage } from './cards-figures.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'set_featured_image',
  description: 'Point one post at its featured image. Takes the URL of a rendered cover or a judged AI illustration. This is the only writer of a post\'s featured-image fields.',
  input_schema: {
    type: 'object',
    properties: {
      blog_slug: { type: 'string' },
      url:       { type: 'string', description: 'the cover_url or winner_url to set' },
      model:     { type: 'string', description: 'what produced it, for the audit trail' },
      prompt:    { type: 'string', description: 'the image prompt, when there was one' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return setFeaturedImage(api, {
    blog_slug:  slugArg(input),
    url:        input.url || null,
    cover_url:  input.cover_url || null,
    winner_url: input.winner_url || null,
    model:      input.model || null,
    prompt:     input.prompt || null,
    actor:      input.actor || 'nyo',
  });
}
