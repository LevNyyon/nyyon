// Digest plugin — execute_digest_action. cmd fronted this with
// POST /api/digest/:id/execute. Sends the reply (quote-reply in-thread when
// possible; a picked slot rides the pack's own send queue), saves the
// wishlist contact through the crm gateway, dismisses, or logs a discuss.

import { executeDigestAction } from './digest.mjs';
import { enqueueWaSend } from './wa-queue.mjs';

export const def = {
  name: 'execute_digest_action',
  description: 'Execute one drafted digest action on an item. type=reply_wa sends the text to the chosen recipient (send_at schedules it through the digest queue instead); type=add_to_wishlist upserts the person into Contacts (crm gateway) with the digest context as notes; type=dismiss marks the item read; type=discuss logs the handoff. draft_blog/draft_social/draft_take belong to the editorial pack and return a pointer.',
  input_schema: {
    type: 'object',
    properties: {
      id:     { type: 'string', description: 'the digest item id' },
      type:   { type: 'string', enum: ['reply_wa', 'add_to_wishlist', 'dismiss', 'discuss', 'draft_blog', 'draft_social', 'draft_take'] },
      text:   { type: 'string', description: 'reply_wa: the final message text' },
      send_at: { type: 'number', description: 'reply_wa: ms epoch to schedule instead of sending now' },
      recipient: { type: 'object', description: 'reply_wa: the chosen recipient {kind, mode, id, name, quotedMessageId?}' },
      metadata:  { type: 'object', description: 'add_to_wishlist: the drafted person metadata' },
      note:      { type: 'string', description: 'add_to_wishlist: extra operator note' },
    },
    required: ['id', 'type'],
  },
};

export async function run(api, input) {
  const { id, ...action } = input;
  return executeDigestAction(api, id, action, { enqueueWaSend });
}
