// GTM plugin — read_prospect_thread. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { readProspectThread } from './outreach-wa.mjs';

export const def = {
  name: 'read_prospect_thread',
  description: 'Open ONE prospect conversation: the full WhatsApp history (oldest first), whether they have ever answered, and the prospect context card (company, title, ICP fit and why, LinkedIn, open roles, org status). Pass chat_id, or lead_id to resolve the chat from the lead\'s phone. Read-only — opening a conversation never writes and never spends a model call.',
  input_schema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string', description: 'WhatsApp DM id, e.g. 972545492444@c.us' },
      lead_id: { type: 'string', description: 'lead id — used to find the chat when chat_id is unknown' },
      limit: { type: 'number', description: 'max messages (default from the outreach-reply-drafting doc)' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return readProspectThread(api, {
    chat_id: input?.chat_id || null, lead_id: input?.lead_id || null, limit: input?.limit || null,
  });
}
