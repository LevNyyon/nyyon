// Digest plugin — digest_actions. cmd fronted this with
// GET /api/digest/:id/actions: LLM-drafts what the operator can do with an
// item (reply on WhatsApp with recipients + routed default, mark person as
// interesting, discuss, dismiss).

import { draftDigestActions } from './digest.mjs';

export const def = {
  name: 'digest_actions',
  description: 'Draft the actions an operator can take on one digest item: an LLM-drafted WhatsApp reply with a recipient picker (group vs private, routed with a default and a reason), a mark-person-as-interesting contact save, discuss, dismiss. Slow (LLM drafting) — call on demand, not in bulk.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
};

export async function run(api, input) {
  return draftDigestActions(api, input.id);
}
