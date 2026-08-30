// GTM plugin — read_promotion_rules. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { loadPromotion } from './outreach-promote.mjs';

export const def = {
  name: 'read_promotion_rules',
  description: 'Read how replies become deals (the outreach-promotion knowledge doc): replied_stage (where a reply lands someone), advance_only (never move a further-along deal back), stage_rank (the board order used to decide "forward") and the tag stamped on promoted records.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return loadPromotion(api);
}
