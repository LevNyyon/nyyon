// Digest plugin — star_digest_item. Ported from cmd's tools/digest.js pool.

import { patchDigestItem } from './digest.mjs';

export const def = {
  name: 'star_digest_item',
  description: 'Pin a digest item by starring it. Stays visible across day rolls. Use when the operator wants to come back to something.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' }, starred: { type: 'boolean' } },
    required: ['id'],
  },
};

export async function run(api, input) {
  return { item: await patchDigestItem(api, input.id, { starred: input.starred !== false }) };
}
