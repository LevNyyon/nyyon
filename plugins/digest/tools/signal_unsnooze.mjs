// Digest plugin: signal_unsnooze. Undo a snooze.

import { unsnoozeItem } from './signal-priority.mjs';

export const def = {
  name: 'signal_unsnooze',
  description: 'Wake a snoozed key again (undo a snooze). Identify it by the digest card that was snoozed, or by the key itself (e.g. "source:techcrunch" or "ref:calendar_events:<id>").',
  input_schema: {
    type: 'object',
    properties: { digest_id: { type: 'string' }, key: { type: 'string' } },
  },
};

export async function run(api, input) {
  return unsnoozeItem(api, input || {});
}
