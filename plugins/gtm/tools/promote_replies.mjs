// GTM plugin — promote_replies. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { promoteRepliesToPipeline } from './outreach-promote.mjs';

export const def = {
  name: 'promote_replies',
  description: "Put replied people on the sales pipeline: create a new prospect client at the replied stage, or advance an existing one FORWARD only — a deal already further along is left where it is. Matches to existing records by linked lead → contact phone/LinkedIn → client name, so re-running never duplicates anyone. Takes { replies } as produced by collect_replies. Rules come from the outreach-promotion knowledge doc. Step 2 of the outreach-replies-to-pipeline workflow.",
  input_schema: {
    type: 'object',
    properties: {
      replies: {
        type: 'array',
        items: { type: 'object' },
        description: "Reply objects from collect_replies. Omit inside the workflow — the runner threads step 1's output in.",
      },
    },
    required: [],
  },
};

export async function run(api, input) {
  return promoteRepliesToPipeline(api, { replies: input?.replies });
}
