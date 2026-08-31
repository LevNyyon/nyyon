// Digest plugin — digest_wa_manual. cmd fronted this with
// POST /api/digest/:id/wa-manual. Hold mode has no queue row to count, so
// the wa.me click IS the outreach act: stamp the card, consume the
// person's other signals, log it.

import { digestWaManual } from './digest.mjs';

export const def = {
  name: 'digest_wa_manual',
  description: 'Record that the operator sent a digest card\'s WhatsApp message BY HAND (opened wa.me and sent it themselves, e.g. while sending is on hold). Stamps the card, archives the person\'s other unread signals (one moment per person), and logs the act.',
  input_schema: {
    type: 'object',
    properties: {
      digest_id: { type: 'string' },
      text:      { type: 'string', description: 'the text that was sent (defaults to the saved draft)' },
    },
    required: ['digest_id'],
  },
};

export async function run(api, input) {
  return digestWaManual(api, input.digest_id, { text: input.text });
}
