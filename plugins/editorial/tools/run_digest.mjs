// Editorial plugin — run_digest. NEW cron entry tool: the host scheduled
// handler used to call generateDigest from lib/digest.js directly (the :30
// awareness-sweep leg); it is rewired to invoke this tool by name. Same lib
// entry as the operator-facing generate_digest tool, but the result is the
// lib's return untouched (the cron logs it raw), so both stay honest to their
// callers.

import { generateDigest } from './digest.mjs';

export const def = {
  name: 'run_digest',
  description: 'Run the digest regenerate pass the cron runs at :30: prune what has gone stale, pull every enabled channel, dedupe against what is already there. Returns the lib\'s raw result. Safe to run by hand to refresh the morning digest now.',
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
