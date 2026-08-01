// Outreach — the workflow definitions (nyyon-lite layer 3).
//
// A workflow is an ordered list of EXISTING tools and nothing else: the runner
// threads one JSON context through them, each step reading what earlier steps
// merged in. No branching, no logic here — where a guarantee needs a loop
// (claim-then-send), the loop lives inside the one tool that owns it and the
// DECISIONS around it are the steps.
//
// Seeded into the `workflows` table; edit a definition there (or with
// write_workflow) to change an order without a deploy.

export const workflows = [
  {
    slug: 'draft-prospect-reply',
    name: 'Outreach · draft the next message',
    description: 'A suggested next message lands in context as {draft, source}: a verbatim approved angle bubble, the default first-touch template, or one composed reply when the prospect has actually said something. NEVER sends — sending is a separate operator action via send_whatsapp. Run with {chat_id} or {lead_id}.',
    trigger: { kind: 'on-demand', note: 'the Outreach WA tab composer; also run_workflow with {chat_id} or {lead_id}' },
    steps: [
      { tool: 'read_prospect_thread' },
      { tool: 'read_lead_angles' },
      { tool: 'read_drafting_rules' },
      { tool: 'pick_next_bubble' },
      { tool: 'compose_reply' },
    ],
  },
  {
    slug: 'outreach-cohort-tick',
    name: 'Outreach · cohort tick',
    description: 'Every due, approved, cleanly-rendering cohort message is sent within the window and the daily cap. Anyone who replied is retired from the automation first, anything that cannot render is stopped fail-closed, and anything the operator has not approved stays visibly due rather than going out. Honors the outreach.live flag — until it is on, the run reports what it WOULD have sent. Accepts {dry_run, force, limit}.',
    trigger: { kind: 'cron', note: 'the cohort sending tick; also on-demand with {dry_run, force, limit}' },
    steps: [
      { tool: 'list_due_members' },
      { tool: 'retire_answered_members' },
      { tool: 'render_member_messages' },
      { tool: 'gate_member_approvals' },
      { tool: 'send_due_messages' },
    ],
  },
  {
    slug: 'outreach-replies-to-pipeline',
    name: 'Outreach · replies → pipeline',
    description: 'Everyone who answered our LinkedIn or WhatsApp outreach lands on the sales board — created as a fresh prospect at the replied stage, or advanced forward if already there (never backward, never duplicated). Rules live in the outreach-promotion knowledge doc.',
    trigger: { kind: 'cron', note: 'hourly :00 leg; also manual via run_workflow' },
    steps: [
      { tool: 'collect_replies' },
      { tool: 'promote_replies' },
    ],
  },
  {
    slug: 'scheduled-send-tick',
    name: 'Outreach · scheduled sends',
    description: 'Due scheduled sends are claimed atomically and delivered exactly once. The claim is one-shot and fail-closed, so a second run — or a crash mid-send — can never produce a duplicate; a claimed or failed row is an operator decision, not a retry queue.',
    trigger: { kind: 'cron', note: 'the same tick the cron already runs (:00 / :06 / :45); also runnable manually' },
    steps: [
      { tool: 'run_due_sends' },
    ],
  },
];
