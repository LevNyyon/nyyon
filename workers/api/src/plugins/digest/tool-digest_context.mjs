// Digest plugin — digest_context. cmd fronted this with
// GET /api/digest/:id/context; the drawer + "Discuss with Nyo" handoff read
// it. For WA items: the original message + chat row + surrounding thread +
// contact-matched participants, so Nyo can speak about the actual thread.

import { getDigestItemContext } from './digest.mjs';

export const def = {
  name: 'digest_context',
  description: 'Source-enriched context for one digest item: the item, and for WhatsApp items the original message, the chat, the surrounding thread and contact-matched participants; for OSINT items the mention row. Use before discussing or replying to an item.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
};

export async function run(api, input) {
  const ctx = await getDigestItemContext(api, input.id);
  if (!ctx) return { error: 'not found' };
  return ctx;
}
