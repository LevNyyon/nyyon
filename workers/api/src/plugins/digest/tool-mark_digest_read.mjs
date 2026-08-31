// Digest plugin — mark_digest_read. Ported from cmd's tools/digest.js pool.

import { patchDigestItem } from './digest.mjs';

export const def = {
  name: 'mark_digest_read',
  description: 'Mark a digest item as read (dismisses it from the unread list). Use after Nyo has acted on or answered an item for the operator.',
  input_schema: {
    type: 'object',
    properties: {
      id:     { type: 'string' },
      read:   { type: 'boolean', description: 'default true; pass false to mark unread again' },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  return { item: await patchDigestItem(api, input.id, { read: input.read !== false }) };
}
