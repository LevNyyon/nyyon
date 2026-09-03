// Editorial plugin — render_images. Ported verbatim from the host blog tools
// (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first). The model enum is the host's
// IMAGE_MODELS list (lib/image-gateway.js MODEL_REGISTRY keys) inlined —
// tool files may not import host code.

import { renderCandidateImages } from './cards-figures.mjs';

const slugArg = (input) => input?.blog_slug || input?.slug || null;

export const def = {
  name: 'render_images',
  description: 'Render N candidate AI images from one prompt and store them. Only their URLs come back — the image bytes never enter the conversation. Hand the candidates to judge_images to pick a winner.',
  input_schema: {
    type: 'object',
    properties: {
      blog_slug: { type: 'string' },
      prompt:    { type: 'string', description: 'from draft_visual_brief' },
      n:         { type: 'number', description: 'candidates to render (default 3, max 4)' },
      model:     { type: 'string', enum: ['flux-schnell', 'sdxl', 'dreamshaper', 'gpt-image-1', 'dall-e-3'], description: 'image model; defaults to gpt-image-1 when an OpenAI key is set, else flux-schnell' },
    },
    required: ['prompt'],
  },
};

export async function run(api, input) {
  return renderCandidateImages(api, {
    blog_slug: slugArg(input),
    prompt: input.prompt,
    n: input.n ?? null,
    model: input.model || null,
  });
}
