// Core · workflow seeds.
//
// One outcome, four existing tools, no logic in between. The runner threads a
// single context: list_due_meetings emits {due_meetings, chatId, lead_minutes},
// claim_due_meetings reads due_meetings and emits {claimed_meetings},
// compose_reminder reads claimed_meetings and emits {chatId, text}, and
// send_whatsapp consumes exactly those two keys.
//
// The at-most-once guarantee is structural, not defensive: the claim step takes
// the reminded_at lock BEFORE the send step exists in the run, and it never
// releases it. A send that fails therefore FAILS THE RUN with the claim held —
// fail closed, no auto-retry, the miss visible in workflow_runs. Never mark the
// send step optional: that would turn a silent delivery failure into a green
// run. And never move the claim after the send.
//
// Because the send step is mandatory, a tick with nothing due would fail on
// "text required". The trigger gates on that: callers run list_due_meetings
// first and only start the workflow when due_meetings is non-empty.

export const workflows = [
  {
    slug: 'meeting-reminders',
    name: 'Cron · meeting reminders',
    description: 'WhatsApp the operator lead_minutes before each meeting, at most once per meeting. Policy (lead time, calendar kinds, target chat, timezone) lives in the meeting-reminders knowledge doc and the Reminders panel; the claim is taken before the send and never released, so a failed send fails the run instead of double-sending later.',
    trigger: {
      kind: 'cron',
      note: 'piggybacks the 30s /api/nyo/pending poll via waitUntil, plus the scheduled handler; com.nyyon.reminders.plist covers headless. Gate on list_due_meetings before starting a run.',
    },
    steps: [
      { tool: 'list_due_meetings' },
      { tool: 'claim_due_meetings' },
      { tool: 'compose_reminder' },
      { tool: 'send_whatsapp' },
    ],
  },
];
