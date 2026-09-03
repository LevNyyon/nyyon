// GTM plugin — save_angles. Ported verbatim from workers/api/src/tools/prospecting.js;
// def and result shape unchanged, env replaced by the capability object.

import { saveAngles } from './gtm-outreach.mjs';

export const def = {
  name: 'save_angles',
  description: 'Persist an outreach-angles payload for a prospect (whole-payload replace — read it, edit the bubbles, save it back). Refuses an empty payload, so a blocked or failed draft can never wipe angles the operator already has. Saving is not sending.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' }, payload: { type: 'object' } },
    required: ['id'],
  },
};

export async function run(api, input) {
  const id = input.id || input.lead?.id;
  const payload = input.payload || input.angles_payload || null;
  if (!payload) return { ok: false, skipped: input.blocked || 'no angles payload to save — nothing was overwritten' };
  return saveAngles(api, id, payload);
}
