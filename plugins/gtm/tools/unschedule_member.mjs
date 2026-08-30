// GTM plugin — unschedule_member. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); def and result shape unchanged, env
// replaced by the capability object, shared code in the pack lib.

import { control } from './outreach-cohorts.mjs';

export const def = {
  name: 'unschedule_member',
  description: "Return one prospect to a draft: they keep their place in the ladder and their approval, they simply have no send time any more. The sender only ever picks up rows that have one, so this takes them out of the run without stopping them. Give them a time again with reschedule_member or launch_members.",
  input_schema: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'] },
};

export async function run(api, input) {
  return control(api, { lead_id: input?.lead_id, action: 'unschedule' });
}
