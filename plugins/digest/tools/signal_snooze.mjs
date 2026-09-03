// Digest plugin: signal_snooze. Keep a card's key out of the brief for a
// while. The sibling-archive comes from digest.mjs (lib files may not import
// each other; the tool wires it).

import { snoozeItem } from './signal-priority.mjs';
import { archiveItemsByKey } from './digest.mjs';

export const def = {
  name: 'signal_snooze',
  description: 'Snooze a digest card for a while (snooze_days in the plugin-digest-signal-priority doc, default 7): a news card mutes its outlet, a calendar card mutes that event. Archives the card and its unread siblings on the same key and keeps new arrivals on that key out of the brief until the snooze expires.',
  input_schema: { type: 'object', properties: { digest_id: { type: 'string' } }, required: ['digest_id'] },
};

export async function run(api, input) {
  return snoozeItem(api, input.digest_id, { archiveItemsByKey });
}
