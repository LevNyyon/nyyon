// Digest plugin — digest_wa_send. Ported from cmd's tools/digest.js pool.
// The card composer's send: ASAP goes straight out through the whatsapp
// gateway, a picked slot rides the pack's own queue; either way the card is
// stamped, the person's other signals are consumed (one moment per person),
// and an edited draft teaches the voice doc.

import { digestWaSend, waSendSlots, readDigestItem } from './digest.mjs';
import { enqueueWaSend } from './wa-queue.mjs';
import { distillDraftEdit } from './draft-voice.mjs';

export const def = {
  name: 'digest_wa_send',
  description: 'Send (or schedule) the WhatsApp draft of a Digest LI-signal card to the person it targets. text defaults to the card\'s saved draft; send_at is a ms epoch (omit for ASAP). The card is stamped queued/scheduled and the person\'s other unread signals are archived (one outreach moment per person). Use the wa_send_slots tool\'s morning/evening times when the operator says "morning" or "evening".',
  input_schema: {
    type: 'object',
    properties: {
      digest_id: { type: 'string' },
      text:      { type: 'string', description: 'override the saved draft' },
      send_at:   { type: 'number', description: 'ms epoch to schedule; omit for ASAP' },
    },
    required: ['digest_id'],
  },
};

export async function run(api, input) {
  const item = await readDigestItem(api, input.digest_id);
  if (!item) return { error: 'digest item not found' };
  const meta = item.meta && typeof item.meta === 'object' ? item.meta : {};
  const text = input.text || meta.draft || meta.draft_original;
  if (!text) return { error: 'no draft on this card and no text given' };
  const r = await digestWaSend(api, input.digest_id, {
    text, ...(input.send_at ? { send_at: input.send_at } : {}),
  }, { enqueueWaSend });
  const { learn, ...pub } = r;
  if (learn) await distillDraftEdit(api, learn).catch(() => {});
  return { ...pub, slots: await waSendSlots(api) };
}
