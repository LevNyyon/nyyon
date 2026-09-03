// Digest plugin: score_signal. Score ONE card on demand.

import { scoreSignalItem } from './signal-priority.mjs';

export const def = {
  name: 'score_signal',
  description: 'Score ONE digest card for the attention it deserves (0-100 + a one-line reason) against the plugin-digest-signal-priority rubric, the operator\'s interest profile and learned taste rules. The score remaps the card into the brief\'s high/mid/low groups.',
  input_schema: { type: 'object', properties: { digest_id: { type: 'string' } }, required: ['digest_id'] },
};

export async function run(api, input) {
  return scoreSignalItem(api, input.digest_id);
}
