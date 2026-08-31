// GTM plugin — enrich_lead. The host route POST /api/gtm/leads/:id/enrich ran
// the enrich-lead WORKFLOW; a pack has no workflows, so this tool runs the same
// chain via the pack lib: enrichFullOne for 'full' (and 'wa' — a subset that
// self-skips the rest), enrichResumeOne for 'resume' — which re-runs ONLY the
// two steps a manual edit unblocks (SerpApi + the LinkedIn confirm) and leaves
// the paid Twilio / PDL lookups alone, exactly as the surface's tooltip promises.

import { getLead, enrichFullOne, enrichResumeOne } from './gtm.mjs';

export const def = {
  name: 'enrich_lead',
  description: "Run the enrichment chain on ONE lead. kind 'full' (default) runs every source — including the paid PDL and Twilio legs (each still self-skips when its answer is already on file); kind 'resume' re-runs only SerpApi + the final LinkedIn confirm, the two steps a typed-in name or pasted profile URL unblocks, and never re-pays a per-lookup source. Per-step verdicts (found / empty / skipped, with reasons) are recorded on the lead.",
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      kind: { type: 'string', description: "'full' (default) | 'resume' | 'wa'" },
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
