// Editorial plugin — claim_aeo_question. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).
//
// Load-bearing guardrail: this is the atomic no-duplicate-write gate for the
// writer — a question can only ever be claimed by one run.

import { claimAeoQuestion } from './aeo-writer.mjs';

export const def = {
  name: 'claim_aeo_question',
  description: 'Claim one interviewed AEO question for writing, so only one run can ever write it. With no slug it claims the next ready question that is due. It refuses a question whose interview is not answered yet, and refuses one another run already claimed — treat either refusal as final rather than retrying.',
  input_schema: {
    type: 'object',
    properties: { question_slug: { type: 'string', description: 'omit to claim the next due ready question' } },
    required: [],
  },
};

export async function run(api, input) {
  return claimAeoQuestion(api, {
    question_slug: input.question_slug || null,
    slug: input.slug || null,
  });
}
