// GTM plugin — draft_step_copy. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { generateStepCopy } from './outreach-cohorts.mjs';

export const def = {
  name: 'draft_step_copy',
  description: "Draft the copy for ONE step of a cohort's sequence, using the cohort name and a sample of who is actually in it as the brief. One model call. Returns the text for the operator to read and edit — it never saves and never sends, so \"every automated message was approved\" stays true even when a model helped write it. step_index 0 is the cold opener.",
  input_schema: {
    type: 'object',
    properties: {
      cohort_id: { type: 'string' },
      step_index: { type: 'number', description: '0 = first touch' },
      language: { type: 'string', description: 'e.g. en, he' },
      instruction: { type: 'string', description: 'optional steer, e.g. "shorter, lead with the hiring signal"' },
    },
    required: ['cohort_id'],
  },
};

export async function run(api, input) {
  return generateStepCopy(api, {
    cohort_id: input?.cohort_id, step_index: Number(input?.step_index) || 0,
    language: input?.language || 'en', instruction: input?.instruction || '',
  });
}
