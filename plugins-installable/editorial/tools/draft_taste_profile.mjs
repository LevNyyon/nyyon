// Editorial plugin — draft_taste_profile. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { draftTasteProfile } from './aeo-taste.mjs';

export const def = {
  name: 'draft_taste_profile',
  description: 'Draft the updated editorial-taste doc from the operator\'s recent reactions, in one reasoning step. It returns the knowledge doc to save and writes nothing, so the update stays visible before it lands.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  const doc = await draftTasteProfile(api);
  return doc || { skipped: true, reason: 'no reactions recorded yet' };
}
