// GTM plugin — collect_replies. Read-only: who answered a message we sent.

import { collectReplies } from './gtm-outreach.mjs';

export const def = {
  name: 'collect_replies',
  description: 'Collect every prospect who REPLIED to our outreach: an inbound WhatsApp message landing after our first send to them. Read-only, so it is safe to run on a tick. Each row is {lead_id, name, company, title, phone, linkedin, replied_at, first_contacted_at, sends}. Use to answer "who has answered".',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return collectReplies(api);
}
