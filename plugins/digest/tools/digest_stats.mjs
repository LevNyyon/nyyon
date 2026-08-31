// Digest plugin — digest_stats. Ported from cmd's tools/digest.js pool.

import { digestStats } from './digest.mjs';

export const def = {
  name: 'digest_stats',
  description: 'Counts: total / unread / high-urgency / actionable / starred, plus when the digest last generated. Use for quick "how does my morning look?" reads.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return digestStats(api);
}
