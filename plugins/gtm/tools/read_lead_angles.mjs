// GTM plugin — read_lead_angles. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { readAngles } from './gtm-outreach.mjs';

export const def = {
  name: 'read_lead_angles',
  description: "Read the outreach angles saved for one lead — the ranked plays and their draft message bubbles. Read-only; drafting new ones is draft_angles. Returns an empty list when nothing has been drafted for them yet.",
  input_schema: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'] },
};

export async function run(api, input) {
  const payload = await readAngles(api, input?.lead_id).catch(() => null);
  return { angles: Array.isArray(payload?.angles) ? payload.angles : [], angles_at: payload?.angles_at || null };
}
