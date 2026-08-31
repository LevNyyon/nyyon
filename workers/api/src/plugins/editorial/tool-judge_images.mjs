// Editorial plugin — judge_images. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { judgeCandidateImages } from './cards-figures.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'judge_images',
  description: 'Score candidate images against the house visual-style doc in one vision step and return the winner\'s URL. It reads each candidate back from storage itself; when no vision model is configured it falls back to the first candidate rather than blocking the post.',
  input_schema: {
    type: 'object',
    properties: {
      candidates: { type: 'array', description: 'from render_images' },
      title:      { type: 'string', description: 'the article title the image is for' },
    },
    required: ['candidates'],
  },
};

export async function run(api, input) {
  return judgeCandidateImages(api, {
    candidates: input.candidates,
    title: input.title || null,
    blog_slug: slugArg(input),
  });
}
