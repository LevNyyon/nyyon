// GTM plugin — render_member_messages. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { renderMemberMessages } from './outreach-cohorts.mjs';

export const def = {
  name: 'render_member_messages',
  description: "Render each due member's next message — the cohort's copy for that step, or the operator's per-person edit — filled in with that prospect's own values. Fail-closed: a message that cannot be filled cleanly (a missing {company}, an unwired channel, a spent ladder) STOPS that member and lands in `blocked` rather than going out with a hole in it. Returns the sendable list. Step 3 of the outreach-cohort-tick workflow.",
  input_schema: {
    type: 'object',
    properties: { due: { type: 'array', items: { type: 'object' }, description: 'due members, after retire_answered_members' } },
    required: [],
  },
};

export async function run(api, input) {
  return renderMemberMessages(api, { due: input?.due || [] });
}
