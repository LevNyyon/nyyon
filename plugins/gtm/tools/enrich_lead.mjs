// GTM plugin — enrich_lead. Runs the enrichment chain for one lead through the
// pack's own pdl / twilio / serp gateways. Every leg self-skips when its key is
// not connected, so an unconnected source records a skip, never a failure.

import { getLead, enrichFullOne, enrichResumeOne } from './gtm.mjs';

export const def = {
  name: 'enrich_lead',
  description: "Run the enrichment chain on ONE lead: company and title off their LinkedIn search result, then People Data Labs, Twilio line validation and a SerpApi socials search. kind 'full' (default) runs every source, each still self-skipping when its answer is already on file or its key is not connected; kind 'resume' re-runs only SerpApi plus the final LinkedIn confirm, the two steps a typed-in name or pasted profile URL unblocks, and never re-pays a per-lookup source. Per-step verdicts (found / empty / skipped, with reasons) are recorded on the lead.",
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      kind: { type: 'string', description: "'full' (default) | 'resume'" },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  if (!input?.id) return { error: 'id required' };
  const lead = await getLead(api, input.id);
  if (!lead) return { error: 'no such lead' };
  return input.kind === 'resume'
    ? enrichResumeOne(api, input.id)
    : enrichFullOne(api, input.id);
}
