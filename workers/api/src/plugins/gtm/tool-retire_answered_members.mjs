// GTM plugin — retire_answered_members. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { retireAnsweredMembers } from './outreach-cohorts.mjs';

export const def = {
  name: 'retire_answered_members',
  description: "Re-read every due member's live conversation and retire anyone who has said something back — permanently, because once a human has spoken the conversation belongs to a human. Runs on ALL due rows, approved or not: skipping the unapproved ones would leave a prospect who replied sitting active forever. Returns the due list with those people removed. A conversation that cannot be read is dropped from this pass rather than sent to (fail-closed). Step 2 of the outreach-cohort-tick workflow.",
  input_schema: {
    type: 'object',
    properties: { due: { type: 'array', items: { type: 'object' }, description: 'due members from list_due_members' } },
    required: [],
  },
};

export async function run(api, input) {
  return retireAnsweredMembers(api, { due: input?.due || [] });
}
