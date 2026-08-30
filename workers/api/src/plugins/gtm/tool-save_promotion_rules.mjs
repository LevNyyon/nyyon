// GTM plugin — save_promotion_rules. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { savePromotion } from './outreach-promote.mjs';

export const def = {
  name: 'save_promotion_rules',
  description: 'Change how replies become deals (the outreach-promotion knowledge doc). Pass only the fields that change. Use for "land replies at talking instead of lead".',
  input_schema: {
    type: 'object',
    properties: {
      replied_stage: { type: 'string' },
      advance_only: { type: 'boolean' },
      stage_rank: { type: 'array', items: { type: 'string' } },
      tag: { type: 'string' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return savePromotion(api, input || {});
}
