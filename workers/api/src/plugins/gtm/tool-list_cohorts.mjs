// GTM plugin — list_cohorts. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { listCohorts } from './outreach-cohorts.mjs';

export const def = {
  name: 'list_cohorts',
  description: 'List the named outreach cohorts (campaigns) with how many prospects each holds — total, active and answered — plus each one\'s status and sending window. Read-only.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return listCohorts(api);
}
