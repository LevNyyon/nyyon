// GTM plugin — send_due_messages. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { sendDueMessages } from './outreach-cohorts.mjs';

export const def = {
  name: 'send_due_messages',
  description: "SEND the approved due cohort messages, within the daily budget and with human spacing between them. For each one the library re-reads the conversation in the moment before it leaves (a reply that landed since is retired, not messaged), advances the step in the same write as the send, and fail-closes on any error — the prospect is stopped, never automatically retried, because a silent retry is how duplicates happen. dry_run reports exactly what would have gone and writes nothing. THIS MESSAGES REAL PEOPLE. Step 5 of the outreach-cohort-tick workflow.",
  input_schema: {
    type: 'object',
    properties: {
      sendable: { type: 'array', items: { type: 'object' }, description: 'approved messages from gate_member_approvals' },
      budget: { type: 'number', description: "how many sends are left in today's cap (from list_due_members)" },
      dry_run: { type: 'boolean', description: 'true = report would-send and write nothing' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return sendDueMessages(api, {
    sendable: input?.sendable || [],
    budget: Number(input?.budget) || 0,
    // Defaults to a dry run: the safe direction for a missing flag here is
    // "nothing sent", never "sent unread".
    dry_run: input?.dry_run === undefined ? true : !!input.dry_run,
  });
}
