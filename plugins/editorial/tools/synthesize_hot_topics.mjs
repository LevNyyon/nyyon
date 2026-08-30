// Editorial plugin — synthesize_hot_topics. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { synthesizeHotTopics } from './heartbeat.mjs';

export const def = {
  name: 'synthesize_hot_topics',
  description: 'Cluster the strongest scored signals into a handful of sharp hot topics, each with a thesis, a why-now and our angle. This is the layer the topic feed and the morning digest lead with.',
  input_schema: {
    type: 'object',
    properties: {
      days:        { type: 'number', description: 'signal lookback (default 10)' },
      min_content: { type: 'number', description: 'defaults to the heartbeat-priorities gate' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return synthesizeHotTopics(api, {
    days: input?.days || 10,
    minContent: input?.min_content ?? null,
  });
}
