// Digest plugin — learn_dismissals. The cron entry tool: the host
// scheduled handler's hourly leg invokes this by name (cmd exposed the same
// pass as digest_learn_interests — this pack keeps the cron-facing name).
// A no-op unless enough new dismissals accumulated since the last pass.

import { learnFromDismissals } from './digest-relevance.mjs';

export const def = {
  name: 'learn_dismissals',
  description: 'Learn from what the operator dismissed in the digest and tune the interest filter: reads the recent dismissed-not-starred items, asks the model what to avoid, and appends the learned avoid-list to the plugin-digest-interests note. No-op unless enough new dismissals accumulated since the last pass — pass force:true to learn now regardless. Use when the operator says "stop showing me this stuff" or "the digest is noisy".',
  input_schema: {
    type: 'object',
    properties: {
      force: { type: 'boolean', description: 'learn even below the new-dismissals threshold' },
      lookback_days: { type: 'number', description: 'how far back to harvest dismissals (default 21)' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return learnFromDismissals(api, {
    force: !!input?.force,
    ...(input?.lookback_days ? { lookbackDays: input.lookback_days } : {}),
  });
}
