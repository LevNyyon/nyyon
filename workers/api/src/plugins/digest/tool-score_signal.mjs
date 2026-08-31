// Digest plugin — score_signal. Ported from cmd's tools/digest.js pool.

import { scoreSignalItem } from './signal-priority.mjs';

export const def = {
  name: 'score_signal',
  description: 'Score ONE digest LI signal for outreach relevance (0-100 + a one-line reason) against the plugin-digest-signal-priority rubric. Mechanical floors apply first: someone with a message already queued, or messaged recently, sinks regardless of content. The score remaps the card into the brief\'s high/mid/low groups.',
  input_schema: { type: 'object', properties: { digest_id: { type: 'string' } }, required: ['digest_id'] },
};

export async function run(api, input) {
  return scoreSignalItem(api, input.digest_id);
}
