// GTM plugin — mark_thread_dead. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { setConversationDead } from './outreach-wa.mjs';

export const def = {
  name: 'mark_thread_dead',
  description: 'Mark one prospect conversation dead so it drops out of the working list, or bring it back with dead:false. Keyed by person, not by chat id. Nothing is deleted either way, and un-marking restores the real state.',
  input_schema: {
    type: 'object',
    properties: {
      lead_id: { type: 'string' },
      dead: { type: 'boolean', description: 'true (default) to mark dead, false to revive' },
      reason: { type: 'string', description: 'optional short note, e.g. "not a fit"' },
    },
    required: ['lead_id'],
  },
};

export async function run(api, input) {
  return setConversationDead(api, {
    lead_id: input?.lead_id, dead: input?.dead !== false, reason: input?.reason || null,
  });
}
