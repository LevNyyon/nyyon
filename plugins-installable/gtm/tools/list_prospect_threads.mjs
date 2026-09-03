// GTM plugin — list_prospect_threads. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { listProspectThreads } from './outreach-wa.mjs';

export const def = {
  name: 'list_prospect_threads',
  description: 'List the WhatsApp conversations that belong to PROSPECTS (people in the lead store we have a 1:1 chat with), newest first. Each row is classified: active (they have answered), unanswered (only our messages so far), fresh (fully enriched, never messaged), scheduled (a queued send waiting), dead (marked dead or nothing for dead_after_days). Read-only. Use to answer "who is in my outreach inbox" or "who is waiting on me".',
  input_schema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'filter by prospect name, company, title, or last message text' },
      status: { type: 'string', description: 'active (default) | working | unanswered | dead | fresh | all' },
      limit: { type: 'number', description: 'max conversations (default from the outreach-reply-drafting doc)' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return listProspectThreads(api, {
    q: input?.q || '', limit: input?.limit || null, status: input?.status || 'active',
  });
}
