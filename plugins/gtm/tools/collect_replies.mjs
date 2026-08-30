// GTM plugin — collect_replies. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { collectReplies } from './outreach-promote.mjs';

export const def = {
  name: 'collect_replies',
  description: 'Collect everyone who REPLIED to our outreach — LinkedIn (prospects marked replied) and WhatsApp (an inbound message after our first send) — normalized to {source, name, company, title, phone, linkedin, lead_id, replied_at}. Read-only. Step 1 of the outreach-replies-to-pipeline workflow; also useful alone to answer "who has answered".',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return collectReplies(api);
}
