// Digest plugin: execute_digest_action. Runs one card verb. Snooze rides
// the signal-priority lib (lib files may not import each other, so the tool
// wires it in as deps).

import { executeDigestAction } from './digest.mjs';
import { snoozeItem } from './signal-priority.mjs';

export const def = {
  name: 'execute_digest_action',
  description: 'Execute one action on a digest item. type=open_link logs the open and returns the url; type=mark_read sets read (pass read:false to un-read); type=star sets starred (pass starred:false to unstar; omitted toggles); type=save_draft stores draft text as the card\'s note; type=snooze keeps the card\'s key (its outlet for news, the event for calendar) out of the brief for snooze_days and archives its unread siblings.',
  input_schema: {
    type: 'object',
    properties: {
      id:      { type: 'string', description: 'the digest item id' },
      type:    { type: 'string', enum: ['open_link', 'mark_read', 'star', 'save_draft', 'snooze'] },
      read:    { type: 'boolean', description: 'mark_read: default true' },
      starred: { type: 'boolean', description: 'star: default toggles' },
      draft:   { type: 'string',  description: 'save_draft: the note text (max 2000 chars kept)' },
    },
    required: ['id', 'type'],
  },
};

export async function run(api, input) {
  const { id, ...action } = input;
  return executeDigestAction(api, id, action, { snoozeItem });
}
