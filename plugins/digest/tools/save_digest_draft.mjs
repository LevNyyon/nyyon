// Digest plugin: save_digest_draft. The page's note auto-save.

import { patchDigestItem } from './digest.mjs';

export const def = {
  name: 'save_digest_draft',
  description: 'Save the operator\'s draft note on a digest card (auto-save from the page). The note lives on the card and shows again whenever it is opened.',
  input_schema: {
    type: 'object',
    properties: {
      id:    { type: 'string' },
      draft: { type: 'string', description: 'the current note text (max 2000 chars kept)' },
    },
    required: ['id', 'draft'],
  },
};

export async function run(api, input) {
  return { item: await patchDigestItem(api, input.id, { draft: String(input.draft ?? '') }) };
}
