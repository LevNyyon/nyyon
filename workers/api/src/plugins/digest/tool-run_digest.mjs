// Digest plugin: run_digest. The cron entry tool: the host scheduled
// handler's :30 leg invokes this by name. Same generate pass as
// generate_digest, kept as its own verb so the cron binding stays stable.

import { generateDigest } from './digest.mjs';

export const def = {
  name: 'run_digest',
  description: 'Run the digest tick the cron runs at :30: prune what has gone stale, pull search headlines and the calendar look-ahead, dedupe against what is already there. Safe to run by hand to refresh the morning digest now.',
  input_schema: {
    type: 'object',
    properties: {
      since_ms: { type: 'number', description: 'lookback window in ms (default 24h)' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return generateDigest(api, input?.since_ms ? { since_ms: input.since_ms } : {});
}
