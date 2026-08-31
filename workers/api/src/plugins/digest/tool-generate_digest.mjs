// Digest plugin — generate_digest. Ported from cmd's tools/digest.js pool.
// This pack owns the name (the digest IS the owner); the editorial pack's
// interim copy is being retired in a parallel pass.

import { generateDigest } from './digest.mjs';

export const def = {
  name: 'generate_digest',
  description: 'Scan recent activity and materialize new digest items. Prunes what has gone stale, then pulls every enabled channel (attention, LinkedIn signals, OSINT insights, WhatsApp, OSINT mentions, content signals, calendar), deduping against existing items. Run when the operator says "give me today\'s brief", "what\'s new?", or first thing each morning.',
  input_schema: {
    type: 'object',
    properties: { since_ms: { type: 'number', description: 'lookback window in ms; default 86_400_000 (24h)' } },
    required: [],
  },
};

export async function run(api, input) {
  return generateDigest(api, { since_ms: input?.since_ms || 86_400_000 });
}
