// Digest plugin — digest_wa_unschedule. cmd fronted this with
// POST /api/digest/:id/wa-unschedule: cancel the queued send, free the card.

import { digestWaUnschedule } from './digest.mjs';
import { cancelWaQueueItem } from './wa-queue.mjs';

export const def = {
  name: 'digest_wa_unschedule',
  description: 'Cancel the scheduled WhatsApp send queued on a digest card (before it fires) and clear the card\'s queued state so it can be sent again.',
  input_schema: {
    type: 'object',
    properties: { digest_id: { type: 'string' } },
    required: ['digest_id'],
  },
};

export async function run(api, input) {
  return digestWaUnschedule(api, input.digest_id, { cancelWaQueueItem });
}
