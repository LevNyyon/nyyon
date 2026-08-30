// GTM plugin — draft_prospect_reply. In the host this was the
// `draft-prospect-reply` WORKFLOW (read_prospect_thread → read_lead_angles →
// read_drafting_rules → pick_next_bubble → compose_reply) fronted by
// POST /api/outreach/wa/draft. A plugin surface drives tools, not workflows,
// so the chain ships as ONE tool over the same lib the step tools share —
// the behaviour and the flat OutreachDraft result shape are unchanged:
// {draft, source: angle|llm|template|none, lead_id?, reason?, step?,
//  first_touch?, angle?, alternatives?, based_on_messages?, at?}.
// NEVER sends — sending stays a separate operator action.

import { draftReply } from './outreach-wa.mjs';

export const def = {
  name: 'draft_prospect_reply',
  description: 'Produce the suggested next message for one prospect conversation: a verbatim approved angle bubble (first touch or follow-up into silence), the default first-touch template when there is no angle, or one composed reply when the prospect has actually said something. force_llm:true composes even into silence. Run with {chat_id} or {lead_id}. A suggestion only — it NEVER sends; sending is a separate operator action.',
  input_schema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string' },
      lead_id: { type: 'string' },
      force_llm: { type: 'boolean', description: 'compose with the model even when they have not replied' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return draftReply(api, {
    chat_id: input?.chat_id || null,
    lead_id: input?.lead_id || null,
    force_llm: !!input?.force_llm,
  });
}
