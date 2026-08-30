// GTM plugin — save_sequence. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { saveSequence } from './outreach-cohorts.mjs';

export const def = {
  name: 'save_sequence',
  description: "Write a cohort's message sequence. Shape: {default_language, steps:[{delay_hours, channel, bodies:{en:\"…\", he:\"…\"}}]} — delay_hours on step 0 counts from go-live, later steps from the previous send. Bodies may use {first_name} {name} {company} {position} {country}; any other {token} is rejected. `scope` decides what happens to people already in the cohort: new_only (default — anyone hand-edited keeps their own message) or everyone (the cohort copy replaces the hand-written ones too). APPROVALS ARE WITHDRAWN EITHER WAY for anyone whose next message this changes, because approval means the operator read that exact text.",
  input_schema: {
    type: 'object',
    properties: {
      cohort_id: { type: 'string' },
      sequence: { type: 'object', description: '{default_language, steps:[{delay_hours, channel, bodies:{lang:text}}]}' },
      scope: { type: 'string', description: 'new_only (default) | everyone' },
    },
    required: ['cohort_id', 'sequence'],
  },
};

export async function run(api, input) {
  return saveSequence(api, {
    cohort_id: input?.cohort_id, sequence: input?.sequence, scope: input?.scope || 'new_only',
  });
}
