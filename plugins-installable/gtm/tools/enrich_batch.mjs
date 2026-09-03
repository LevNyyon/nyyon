// GTM plugin — enrich_batch. The host had no tool for this: POST /api/gtm/enrich
// called lib enrichBatchStep directly. The surface (and Nyo) loops this while
// remaining > 0 so each invocation stays small (2 leads/call) instead of one
// long background chain. Result: { enriched, remaining, results }.

import { enrichBatchStep } from './gtm.mjs';

export const def = {
  name: 'enrich_batch',
  description: "Enrich the next few still-'new' leads of one batch through the full chain (LinkedIn result → PDL → Twilio → SerpApi → confirm; every source self-skips when its key is not connected or its answer is already on file). Call in a loop while `remaining` > 0 — each call takes at most `limit` (1-5, default 2) leads so a run never outgrows one invocation.",
  input_schema: {
    type: 'object',
    properties: {
      batch_id: { type: 'string' },
      limit: { type: 'number', description: 'leads per call, 1-5 (default 2)' },
    },
    required: ['batch_id'],
  },
};

export async function run(api, input) {
  if (!input?.batch_id) return { error: 'batch_id required' };
  return enrichBatchStep(api, { batch_id: input.batch_id, limit: input.limit || 2 });
}
