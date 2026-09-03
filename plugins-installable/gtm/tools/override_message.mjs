// GTM plugin — override_message. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { saveMessageOverride } from './outreach-cohorts.mjs';

export const def = {
  name: 'override_message',
  description: "Rewrite the next message for ONE prospect, for that prospect only — the cohort's own copy is untouched and everyone else still gets what was authored for the group. The edit is bound to the step they are on, so it can never become the text of a later message. Variables still work and are refused at save time if this prospect has no value for them. Saving an edit WITHDRAWS any approval, because approval means the operator read the text and the text just changed. clear:true drops the edit and restores the cohort copy.",
  input_schema: {
    type: 'object',
    properties: {
      lead_id: { type: 'string' },
      text: { type: 'string', description: 'the replacement message' },
      clear: { type: 'boolean', description: 'true to remove the edit and restore the cohort copy' },
    },
    required: ['lead_id'],
  },
};

export async function run(api, input) {
  return saveMessageOverride(api, {
    lead_id: input?.lead_id, text: input?.text || '', clear: !!input?.clear,
  });
}
