// GTM plugin — create_cohort. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { createCohort } from './outreach-cohorts.mjs';

export const def = {
  name: 'create_cohort',
  description: 'Create a named outreach cohort. Idempotent by name — creating one that already exists hands back the existing cohort rather than a duplicate.',
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string' }, note: { type: 'string', description: 'optional description' } },
    required: ['name'],
  },
};

export async function run(api, input) {
  return createCohort(api, { name: input?.name, note: input?.note || null });
}
