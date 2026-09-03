// GTM plugin — stop_member. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); def and result shape unchanged, env
// replaced by the capability object, shared code in the pack lib.

import { control } from './outreach-cohorts.mjs';

export const def = {
  name: 'stop_member',
  description: "Stop one prospect's ladder for good. Terminal but visible — the enrolment row stays, so the operator can see it was stopped rather than wondering where they went. Use remove_member to take them off the cohort entirely.",
  input_schema: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'] },
};

export async function run(api, input) {
  return control(api, { lead_id: input?.lead_id, action: 'stop' });
}
