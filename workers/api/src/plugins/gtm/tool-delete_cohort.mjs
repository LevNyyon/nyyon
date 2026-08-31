// GTM plugin — delete_cohort. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { deleteCohort } from './outreach-cohorts.mjs';

export const def = {
  name: 'delete_cohort',
  description: 'Delete an empty cohort. Refuses while any prospect is still enrolled in it, and refuses the default cohort.',
  input_schema: { type: 'object', properties: { cohort_id: { type: 'string' } }, required: ['cohort_id'] },
};

export async function run(api, input) {
  return deleteCohort(api, { cohort_id: input?.cohort_id });
}
