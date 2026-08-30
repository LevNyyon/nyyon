// Editorial plugin — generate_blog_image. NEW tool fronting what the host
// /api/blog/:slug/generate-image route did (the blog-featured-image pipeline):
// draft a visual brief from the article, render AI candidates through the host
// render gateway, judge them, and point the post at the winner. The whole
// chain lives in the pack's cards-figures lib; pixel work stays in the host
// gateway.

import { regenerateBlogFeaturedImage } from './cards-figures.mjs';

export const def = {
  name: 'generate_blog_image',
  description: "Generate (or regenerate) one blog post's AI featured image: brief → candidate renders → vision judge → the winner becomes the cover. Pass prompt_override to skip the brief drafter and render exactly that scene. Returns {image:{url, model, prompt, ...}}.",
  input_schema: {
    type: 'object',
    properties: {
      slug:            { type: 'string', description: 'the blog post slug' },
      prompt_override: { type: 'string', description: 'render exactly this image prompt instead of drafting a brief' },
      model:           { type: 'string', description: 'image model override' },
    },
    required: ['slug'],
  },
};

export async function run(api, input) {
  const image = await regenerateBlogFeaturedImage(api, input.slug, {
    actor:           input.actor || 'operator',
    prompt_override: input.prompt_override || null,
    model:           input.model || null,
  });
  // Same {image} envelope the old route answered the ops UI with.
  return { image };
}
