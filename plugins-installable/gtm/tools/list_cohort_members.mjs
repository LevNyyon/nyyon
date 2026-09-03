// GTM plugin — list_cohort_members. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { listCohortMembers } from './outreach-cohorts.mjs';

export const def = {
  name: 'list_cohort_members',
  description: 'List enrolled prospects with everything the sheet shows: which cohort, what we last said, the NEXT message rendered for that person (variables filled, in their language), when it goes, whether the operator approved it, and where their real conversation stands (untouched | touched | active | dead). Filter with status (staged | active | answered | paused | done | stopped | all) and/or cohort_id. Read-only; also returns the cohorts and whether live sending is on.',
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'staged | active | answered | paused | done | stopped | all' },
      cohort_id: { type: 'string', description: 'limit to one cohort; omit or "all" for every cohort' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return listCohortMembers(api, {
    status: input?.status || null, cohort_id: input?.cohort_id || null,
  });
}
