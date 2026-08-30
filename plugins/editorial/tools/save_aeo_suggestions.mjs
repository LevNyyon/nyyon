// Editorial plugin — save_aeo_suggestions. Ported verbatim from the host blog
// tools (workers/api/src/tools/blog.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { saveAeoSuggestions } from './aeo-suggestions.mjs';

export const def = {
  name: 'save_aeo_suggestions',
  description: 'Save developed angles as pending AEO suggestions for the operator to approve or reject. Signals that already produced a suggestion are skipped, and each source signal is marked actioned so the same news is never suggested twice.',
  input_schema: {
    type: 'object',
    properties: {
      suggestions: { type: 'array', description: 'from draft_suggestion_angles' },
      signals:     { type: 'array', description: 'the source signals, for provenance' },
      limit:       { type: 'number' },
    },
    required: ['suggestions'],
  },
};

export async function run(api, input) {
  return saveAeoSuggestions(api, {
    suggestions: input.suggestions,
    signals: Array.isArray(input.signals) ? input.signals : null,
    limit: input.limit ?? null,
  });
}
