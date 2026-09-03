// Editorial plugin — dismiss_hottake_topic. Surface entry point for the old
// POST /api/hot-takes/topics/dismiss route: drop a Topics-of-the-Day card the
// operator judged not good enough. Persisted, so the hourly sweep can never
// resurface it.

import { dismissTopicCard } from './hot-takes.mjs';

export const def = {
  name: 'dismiss_hottake_topic',
  description: 'Remove one Topics-of-the-Day card from the feed for good. Pass the card\'s origin + origin_ref (and title for the audit trail). The dismissal is stored, so the card stays gone across sweeps.',
  input_schema: {
    type: 'object',
    properties: {
      origin:     { type: 'string' },
      origin_ref: { type: 'string' },
      title:      { type: 'string' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return { package: await dismissTopicCard(api, input || {}, input?.actor || 'operator') };
}
