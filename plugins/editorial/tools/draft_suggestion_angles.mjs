// Editorial plugin — draft_suggestion_angles. Ported verbatim from the host
// blog tools (workers/api/src/tools/blog.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { draftSuggestionAngles } from './aeo-suggestions.mjs';

export const def = {
  name: 'draft_suggestion_angles',
  description: 'Develop scored industry signals into article angles in one reasoning step: a working title, the keyword, our specific take and why it is worth writing now. It deduplicates against existing posts and queued topics and saves nothing.',
  input_schema: {
    type: 'object',
    properties: {
      signals: { type: 'array', description: 'candidate signals from list_signals' },
      limit:   { type: 'number', description: 'how many to select at most' },
    },
    required: ['signals'],
  },
};

export async function run(api, input) {
  return draftSuggestionAngles(api, {
    signals: input.signals,
    limit: input.limit ?? null,
  });
}
