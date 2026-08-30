// GTM plugin — launch_members. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { goLive } from './outreach-cohorts.mjs';

export const def = {
  name: 'launch_members',
  description: "Schedule specific STAGED prospects to start their cohort's sequence. This is the ONLY thing that turns a staged enrolment into scheduled messages. Refuses anyone whose messages would not render cleanly (a missing {company}, a cohort with no sequence yet) and reports them in `blocked` rather than arming something with a gap in it. Actual delivery still needs the message approved and the outreach.live flag on.",
  input_schema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      start_at: { type: 'number', description: 'ms epoch to start from; defaults to now (still held to the sending window)' },
    },
    required: ['lead_ids'],
  },
};

export async function run(api, input) {
  return goLive(api, { lead_ids: input?.lead_ids || [], start_at: input?.start_at || null });
}
