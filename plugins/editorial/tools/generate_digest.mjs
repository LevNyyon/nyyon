// Editorial plugin — generate_digest. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { generateDigest } from './digest.mjs';

export const def = {
  name: 'generate_digest',
  description: 'Regenerate the morning digest from every enabled channel: prune what has gone stale, pull each channel, dedupe against what is already there. A step in the hourly awareness sweep — read the result with the digest listing tools.',
  input_schema: {
    type: 'object',
    properties: { since_ms: { type: 'number', description: 'lookback window in ms (default 24h)' } },
    required: [],
  },
};

// Channel fan-out with per-channel error capture lives in the lib: one
// flaky source must never cost the whole brief.
export async function run(api, input) {
  const r = await generateDigest(api, { since_ms: input?.since_ms || 86_400_000 });
  return { generated: r.generated, pruned: r.pruned, per_source: r.per_source };
}
