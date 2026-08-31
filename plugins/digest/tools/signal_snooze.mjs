// Digest plugin — signal_snooze. Ported from cmd's tools/digest.js pool.

import { snoozePerson } from './signal-priority.mjs';
import { consumeSignalsForPerson } from './digest.mjs';

export const def = {
  name: 'signal_snooze',
  description: 'Snooze a person for a while (snooze_days in the plugin-digest-signal-priority doc, default 7): archives their open signals and keeps new ones out of the brief until it expires. Distinct from engaging (signal_acted), which keeps them flowing.',
  input_schema: { type: 'object', properties: { digest_id: { type: 'string' } }, required: ['digest_id'] },
};

export async function run(api, input) {
  return snoozePerson(api, input.digest_id, { consumeSignalsForPerson });
}
