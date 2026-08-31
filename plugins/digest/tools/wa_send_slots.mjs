// Digest plugin — wa_send_slots. Ported from cmd's tools/digest.js pool.

import { waSendSlots } from './digest.mjs';

export const def = {
  name: 'wa_send_slots',
  description: 'Read the WhatsApp send-slot config (morning/evening wall-clock times, days ahead, timezone, per-recipient tz prefixes, hold flag) from the plugin-digest-wa-send-slots knowledge doc, for proposing schedule times.',
  input_schema: { type: 'object', properties: {} },
};

export async function run(api) {
  return waSendSlots(api);
}
