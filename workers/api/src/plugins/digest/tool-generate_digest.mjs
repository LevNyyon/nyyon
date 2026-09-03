// Digest plugin: generate_digest. The generate pass without the cron
// wrapper: prune, then pull search + calendar.

import { generateDigest } from './digest.mjs';

export const def = {
  name: 'generate_digest',
  description: 'Scan and materialize new digest items. Prunes what has gone stale, then pulls the two sources this install has (search headlines for the operator\'s topics through any installed search provider, and the calendar look-ahead), deduping against existing items. Run when the operator says "give me today\'s brief", "what\'s new?", or first thing each morning.',
  input_schema: {
    type: 'object',
    properties: { since_ms: { type: 'number', description: 'lookback window in ms; default 86_400_000 (24h)' } },
    required: [],
  },
};

export async function run(api, input) {
  return generateDigest(api, { since_ms: input?.since_ms || 86_400_000 });
}
