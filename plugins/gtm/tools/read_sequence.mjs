// GTM plugin — read_sequence. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { readSequence } from './outreach-cohorts.mjs';

export const def = {
  name: 'read_sequence',
  description: "Read a cohort's message sequence — the copy the whole group receives, written once and personalised per recipient — plus a validation report (steps, languages, variables used, unknown variables, unwired channels). Read-only.",
  input_schema: { type: 'object', properties: { cohort_id: { type: 'string' } }, required: ['cohort_id'] },
};

export async function run(api, input) {
  return readSequence(api, { cohort_id: input?.cohort_id });
}
