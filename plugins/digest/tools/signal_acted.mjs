// Digest plugin — signal_acted. Ported from cmd's tools/digest.js pool.

import { actOnSignal } from './signal-priority.mjs';

export const def = {
  name: 'signal_acted',
  description: 'Record that the operator ENGAGED with a signal (liked/commented on LinkedIn himself, or handled it another way): counts toward that person\'s lead heat and clears this one card. Their other and future signals keep flowing — engaging is a reason to keep watching them.',
  input_schema: { type: 'object', properties: { digest_id: { type: 'string' } }, required: ['digest_id'] },
};

export async function run(api, input) {
  return actOnSignal(api, input.digest_id);
}
