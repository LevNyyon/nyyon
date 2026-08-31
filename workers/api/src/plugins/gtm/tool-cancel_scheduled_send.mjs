// GTM plugin — cancel_scheduled_send. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { cancelOrDismiss } from './gtm-schedule.mjs';

export const def = {
  name: 'cancel_scheduled_send',
  description: 'Cancel a scheduled send before it fires, or dismiss a terminal failed/partial one (the reply says which of the two happened). A claimed, in-flight send cannot be un-fired — that is the fail-closed guarantee, and it is an operator decision to review rather than a retry queue.',
  input_schema: {
    type: 'object',
    properties: { schedule_id: { type: 'string', description: 'the ss_ schedule id' } },
    required: ['schedule_id'],
  },
};

export async function run(api, input) {
  return cancelOrDismiss(api, input?.schedule_id);
}
