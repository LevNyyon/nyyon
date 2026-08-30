// GTM plugin — gate_member_approvals. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { gateMemberApprovals } from './outreach-cohorts.mjs';

export const def = {
  name: 'gate_member_approvals',
  description: "Hold back any sendable message the operator has not approved for its exact step, while the cadence doc's require_approval is on. Held rows keep their send time on purpose, so an unapproved message stays a visible backlog at the top of its cohort instead of quietly dropping out of the run. Returns the sendable list narrowed to approved messages plus what is awaiting. Step 4 of the outreach-cohort-tick workflow.",
  input_schema: {
    type: 'object',
    properties: { sendable: { type: 'array', items: { type: 'object' }, description: 'rendered messages from render_member_messages' } },
    required: [],
  },
};

export async function run(api, input) {
  return gateMemberApprovals(api, { sendable: input?.sendable || [] });
}
