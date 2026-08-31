// GTM plugin — enroll_members. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { enrollMany } from './outreach-cohorts.mjs';

export const def = {
  name: 'enroll_members',
  description: 'Stage prospects into a cohort. They are STAGED, not scheduled — filing someone into a cohort must never be the thing that causes a message; launch_members is the only step that arms one. Returns three lists: added, conflicts (already in ANOTHER cohort — nobody may be in two, so these need an explicit override) and skipped (no phone, already replied, already in this cohort). Pass override:true ONLY after a human approved moving those specific people; an override MOVES them, it never duplicates.',
  input_schema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      cohort_id: { type: 'string', description: 'target cohort; defaults to the general one' },
      override: { type: 'boolean', description: 'move prospects already enrolled elsewhere — requires operator approval' },
    },
    required: ['lead_ids'],
  },
};

export async function run(api, input) {
  return enrollMany(api, {
    lead_ids: input?.lead_ids || [], cohort_id: input?.cohort_id || null, override: !!input?.override,
  });
}
