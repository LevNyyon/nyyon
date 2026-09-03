// Editorial plugin — read_suggestion_policy. Ported verbatim from the host
// blog tools (workers/api/src/tools/blog.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { readSuggestionPolicy } from './aeo-suggestions.mjs';

export const def = {
  name: 'read_suggestion_policy',
  description: 'Read the AEO suggestion policy (daily limit, cap on the unreviewed pile, minimum signal score) together with how much room is left today. Call it first: it tells the next steps how many signals to develop and how good they must be.',
  input_schema: {
    type: 'object',
    properties: { limit: { type: 'number', description: 'override the policy daily limit for this run' } },
    required: [],
  },
};

export async function run(api, input) {
  return readSuggestionPolicy(api, { limit: input?.limit ?? null });
}
