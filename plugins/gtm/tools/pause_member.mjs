// GTM plugin — pause_member. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { control } from './outreach-cohorts.mjs';

export const def = {
  name: 'pause_member',
  description: "Pause one prospect's automated ladder, or resume it with paused:false. Pausing keeps their place and their approval; resuming is refused for anyone who has replied, because a prospect who answered is out of the automation permanently.",
  input_schema: {
    type: 'object',
    properties: { lead_id: { type: 'string' }, paused: { type: 'boolean', description: 'true to pause, false to resume' } },
    required: ['lead_id', 'paused'],
  },
};

export async function run(api, input) {
  return control(api, { lead_id: input?.lead_id, action: input?.paused === false ? 'resume' : 'pause' });
}
