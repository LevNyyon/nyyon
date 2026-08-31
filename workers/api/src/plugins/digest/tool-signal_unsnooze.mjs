// Digest plugin — signal_unsnooze. Ported from cmd's tools/digest.js pool.

import { unsnoozePerson } from './signal-priority.mjs';

export const def = {
  name: 'signal_unsnooze',
  description: 'Wake a muted person\'s signals again (undo a snooze). Identify them by prospect_id, phone, or name.',
  input_schema: {
    type: 'object',
    properties: { prospect_id: { type: 'string' }, phone: { type: 'string' }, name: { type: 'string' } },
  },
};

export async function run(api, input) {
  return unsnoozePerson(api, input || {});
}
