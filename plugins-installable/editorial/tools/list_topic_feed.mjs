// Editorial plugin — list_topic_feed. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { topicsOfTheDay } from './hot-takes.mjs';

export const def = {
  name: 'list_topic_feed',
  description: 'The live feed of topics worth a company response — synthesized hot topics, scored industry signals and actionable digest items merged, deduped and newest-first. Read-only; pin a card with pin_hottake_topic to start a package. Pass history:true (with a bigger limit) or q to browse and search everything retained.',
  input_schema: {
    type: 'object',
    properties: {
      limit:   { type: 'number' },
      offset:  { type: 'number' },
      q:       { type: 'string', description: 'search across all retained cards' },
      history: { type: 'boolean', description: 'widen the window past today\'s feed' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return topicsOfTheDay(api, input || {});
}
