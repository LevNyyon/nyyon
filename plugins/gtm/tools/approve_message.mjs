// GTM plugin — approve_message. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { approveMessages } from './outreach-cohorts.mjs';

export const def = {
  name: 'approve_message',
  description: 'Approve (or withdraw approval of) the NEXT message for one or more cohort members. Approval is per message, not per person: it applies to the exact step each prospect is on and lapses by itself the moment that message is sent, so the following one needs approving again. Approving neither schedules nor sends. Refuses anyone who has replied, whose copy cannot be filled in, or whose edited message has a hole in it — a 200 does not mean everyone was approved, read the refused list.',
  input_schema: {
    type: 'object',
    properties: {
      lead_ids: { type: 'array', items: { type: 'string' } },
      approve: { type: 'boolean', description: 'false to withdraw a previous approval. Defaults to true.' },
    },
    required: ['lead_ids'],
  },
};

export async function run(api, input) {
  return approveMessages(api, {
    lead_ids: input?.lead_ids || [], approve: input?.approve !== false,
  });
}
