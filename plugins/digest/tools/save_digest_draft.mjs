// Digest plugin — save_digest_draft. NEW tool for the page's draft
// auto-save (cmd fronted this with PATCH /api/digest/:id — a plugin surface
// drives its own tools instead). The FIRST edit snapshots the AI original
// so the send can teach the voice doc.

import { patchDigestItem } from './digest.mjs';

export const def = {
  name: 'save_digest_draft',
  description: 'Save the operator\'s edited WhatsApp draft on a digest card (auto-save). The first edit snapshots the AI\'s original so a later send can diff the two and learn the operator\'s voice.',
  input_schema: {
    type: 'object',
    properties: {
      id:    { type: 'string' },
      draft: { type: 'string', description: 'the current draft text (max 2000 chars kept)' },
    },
    required: ['id', 'draft'],
  },
};

export async function run(api, input) {
  return { item: await patchDigestItem(api, input.id, { draft: String(input.draft ?? '') }) };
}
