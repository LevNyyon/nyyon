// GTM plugin — run_cohort_tick. In the host this was the
// `outreach-cohort-tick` WORKFLOW (list_due_members → retire_answered_members
// → render_member_messages → gate_member_approvals → send_due_messages)
// fronted by POST /api/outreach/cohort/tick. A plugin surface drives tools,
// not workflows, so the whole tick ships as ONE tool over the same engine the
// step tools share (runCohortTick keeps the claim-then-send loop in one
// breath, which is the duplicate-send guarantee). Result shape matches what
// the Cohorts sheet reads: {ran, reason?, dry_run, live?, due, sent,
// next_open?, awaiting_approval?, results[]}. Honors the outreach.live flag —
// until it is on, the run reports what it WOULD have sent.

import { runCohortTick } from './outreach-cohorts.mjs';

export const def = {
  name: 'run_cohort_tick',
  description: 'Run the whole cohort sending tick: every due, approved, cleanly-rendering cohort message is sent within the window and the daily cap; anyone who replied is retired first; anything unapproved stays visibly due. dry_run:true previews exactly what the next run would send without sending it (the sheet\'s "preview run"); force:true ignores the sending window. Honors the outreach.live flag.',
  input_schema: {
    type: 'object',
    properties: {
      dry_run: { type: 'boolean', description: 'preview only — nothing is sent. Default: whatever the outreach.live flag implies.' },
      force: { type: 'boolean', description: 'run even outside the sending window' },
      limit: { type: 'number', description: 'cap how many members are considered' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return runCohortTick(api, {
    dry_run: input?.dry_run === undefined || input?.dry_run === null ? null : !!input.dry_run,
    force: !!input?.force,
    limit: input?.limit || null,
  });
}
