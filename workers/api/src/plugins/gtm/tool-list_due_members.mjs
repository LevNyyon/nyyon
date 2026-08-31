// GTM plugin — list_due_members. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { listDueMembers } from './outreach-cohorts.mjs';

export const def = {
  name: 'list_due_members',
  description: "List the cohort members whose next message is due right now, inside the sending window, with how much of today's send budget is left. Returns ran:false with a reason when the window is shut or the daily cap is spent. Read-only. Step 1 of the outreach-cohort-tick workflow; also useful alone to answer \"what is going out today\".",
  input_schema: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: 'ignore the quiet-hours / weekday window' },
      dry_run: { type: 'boolean', description: 'true = never send, just report. Defaults to the outreach.live flag.' },
      limit: { type: 'number', description: 'max members to consider this pass (capped at 50)' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return listDueMembers(api, {
    force: !!input?.force,
    dry_run: input?.dry_run === undefined ? null : !!input.dry_run,
    limit: input?.limit || null,
  });
}
