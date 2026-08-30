// Editorial plugin — learn_dismissals. NEW cron entry tool: the host
// scheduled handler used to import learnFromDismissals from
// lib/digest-relevance.js directly (the digest consideration layer's nightly
// learn pass); it is rewired to invoke this tool by name. Thin wrapper — the
// dismissal harvest, the LLM judgement and the interest-profile append (via
// api.saveKnowledge on the plugin-owned digest policy doc) all live in the
// ported lib; the result is the lib's return untouched. A no-op unless enough
// new dismissals have accumulated since the last pass, so it is safe on every
// tick.

import { learnFromDismissals } from './digest-relevance.mjs';

export const def = {
  name: 'learn_dismissals',
  description: 'Learn from what the operator dismissed in the digest and tune the interest filter: reads the recent dismissed-not-starred items, asks the model what to avoid, and appends the learned avoid-list to the digest policy note. No-op unless enough new dismissals accumulated since the last pass — pass force:true to learn now regardless.',
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
