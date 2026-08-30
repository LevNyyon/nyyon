// Editorial plugin — list_hot_topics. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { topHotTopics } from './heartbeat.mjs';

export const def = {
  name: 'list_hot_topics',
  description: 'List the current synthesized hot topics — blog-grade angles on what is happening now, each with a thesis, why-now and source links. Use when asked "what should we write about" or "what is hot".',
  input_schema: {
    type: 'object',
    properties: { limit: { type: 'number' }, days: { type: 'number' }, q: { type: 'string' } },
    required: [],
  },
};

export async function run(api, input) {
  const topics = await topHotTopics(api, {
    limit: input?.limit || 6,
    days: input?.days || 3,
    q: input?.q || '',
  });
  return {
    topics: topics.map((t) => ({
      id: t.id, title: t.title, thesis: t.thesis, why_now: t.why_now,
      angle: t.angle, format: t.format, heat: t.heat, sources: t.sources,
    })),
  };
}
