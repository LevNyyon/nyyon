// GTM plugin — remove_member. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { remove } from './outreach-cohorts.mjs';

export const def = {
  name: 'remove_member',
  description: 'Take one prospect off the cohort entirely (deletes the enrolment row). Their conversation and message history are untouched.',
  input_schema: {
    type: 'object',
    properties: { lead_id: { type: 'string' }, reason: { type: 'string' } },
    required: ['lead_id'],
  },
};

export async function run(api, input) {
  return remove(api, { lead_id: input?.lead_id, reason: input?.reason || 'manual' });
}
