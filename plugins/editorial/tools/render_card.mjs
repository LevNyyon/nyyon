// Editorial plugin — render_card. Ported verbatim from the host social tools
// (workers/api/src/tools/social.js); env → api. The actual pixels (resvg,
// fonts, storage) stay host-side behind api.gateway('render','card') — the
// lib's renderSocialCard is a pure passthrough to that boundary.

import { renderSocialCard } from './cards-figures.mjs';

export const def = {
  name: 'render_card',
  description: 'Render one share card to a PNG in R2 from a template + its slot text. Code-drawn in the brand (no image model, no cost); the same blog slug and template always overwrite the same object, so re-rendering replaces the card instead of littering the bucket. Returns the public URL.',
  input_schema: {
    type: 'object',
    properties: {
      template:  { type: 'string', enum: ['split', 'statement', 'checklist', 'flow'] },
      slots:     { type: 'object', description: 'slot text for that template' },
      blog_slug: { type: 'string', description: 'names the stored object; omit for a one-off card' },
    },
    required: ['template', 'slots'],
  },
};

export async function run(api, input) {
  return {
    card: await renderSocialCard(api, {
      blog_slug: input?.blog_slug || input?.slug || null,
      template:  input?.template,
      slots:     input?.slots,
    }),
  };
}
