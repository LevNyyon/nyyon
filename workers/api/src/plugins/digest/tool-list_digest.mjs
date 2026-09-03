// Digest plugin: list_digest. The brief, urgency-sorted.

import { listDigestItems } from './digest.mjs';

export const def = {
  name: 'list_digest',
  description: 'Read today\'s digest items, the morning brief. Sources: search headlines for the operator\'s topics and the calendar look-ahead. Default returns UNREAD items, urgency-sorted (high first). Set unread_only=false to see everything.',
  input_schema: {
    type: 'object',
    properties: {
      unread_only:  { type: 'boolean', description: 'default true' },
      starred_only: { type: 'boolean' },
      limit:        { type: 'number',  description: 'default 200' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return {
    items: await listDigestItems(api, {
      unread_only:  input?.unread_only !== false,
      starred_only: !!input?.starred_only,
      limit:        input?.limit ?? 200,
    }),
  };
}
