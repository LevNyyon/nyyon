// Editorial plugin — enrich_signals. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { enrichSignals } from './heartbeat.mjs';

export const def = {
  name: 'enrich_signals',
  description: 'Re-score the high-relevance signals from their full article text instead of their headline, caching the text as it goes. Bounded per run; use when the titles alone are not enough to judge what is worth writing about.',
  input_schema: {
    type: 'object',
    properties: {
      limit:         { type: 'number' },
      min_relevance: { type: 'number', description: 'defaults to the heartbeat-priorities gate' },
    },
    required: [],
  },
};

// Fetch-then-rejudge per signal, bounded: the pairing is the guarantee (a
// fetched article is always scored from its own text, never a stale title).
export async function run(api, input) {
  return enrichSignals(api, {
    limit: input?.limit || 12,
    minRelevance: input?.min_relevance ?? null,
  });
}
