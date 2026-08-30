// GTM plugin — reschedule_member. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { rescheduleMember } from './outreach-cohorts.mjs';

export const def = {
  name: 'reschedule_member',
  description: "Move WHEN one prospect's next message goes out. Stores exactly the moment given — it is NOT snapped into the cohort's window, because the sender only runs inside that window anyway, so an out-of-window time simply means the first chance after it; the reply says `outside_window` when that is the case. Giving a time to a STAGED prospect is a launch and carries the same guard (their whole sequence must render cleanly first). Does not touch approval: moving when a message goes does not change what it says. Refused for anyone who has replied, or who is stopped/finished.",
  input_schema: {
    type: 'object',
    properties: { lead_id: { type: 'string' }, send_at: { type: 'number', description: 'ms epoch' } },
    required: ['lead_id', 'send_at'],
  },
};

export async function run(api, input) {
  return rescheduleMember(api, { lead_id: input?.lead_id, send_at: input?.send_at });
}
