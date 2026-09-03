// Digest plugin: digest_actions. The verbs an operator can run on one card
// (open link, mark read, star, save a draft note, snooze). No drafting, no
// LLM: the list is mechanical and cheap.

import { draftDigestActions } from './digest.mjs';

export const def = {
  name: 'digest_actions',
  description: 'List the actions an operator can take on one digest item: open its link, mark it read (or unread), star it, save a draft note on it, or snooze it (a news card snoozes its outlet, a calendar card snoozes that event). Returns the item, its context, and the action list; run one with execute_digest_action.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
};

export async function run(api, input) {
  return draftDigestActions(api, input.id);
}
