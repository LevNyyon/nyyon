// Editorial plugin — save_social_card. Ported verbatim from the host social
// tools (workers/api/src/tools/social.js); env → api, shared code in the
// pack's parallel lib. The record lands in plugin_editorial_social_cards.

import { saveSocialCardRecord } from './cards-figures.mjs';

export const def = {
  name: 'save_social_card',
  description: 'Record a rendered share card in the social_cards table so it shows up in the card history and can be reused as a post image. Takes the card render_card returned.',
  input_schema: {
    type: 'object',
    properties: {
      card:      { type: 'object', description: 'the {url, key, template, width, height} render_card returned' },
      slots:     { type: 'object', description: 'the slot text the card was rendered from' },
      blog_slug: { type: 'string' },
      actor:     { type: 'string' },
    },
    required: ['card'],
  },
};

export async function run(api, input) {
  return {
    ok: true,
    card: await saveSocialCardRecord(api, {
      card:      input?.card,
      blog_slug: input?.blog_slug || input?.slug || null,
      slots:     input?.slots || null,
      actor:     input?.actor || 'nyo',
    }),
  };
}
