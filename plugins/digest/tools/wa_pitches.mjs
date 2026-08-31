// Digest plugin — wa_pitches. cmd fronted this with
// GET /api/digest/wa-pitches: the composer's canned openers. The basic
// pitch is sourced live from the gtm pack's first-touch doc (declared
// host-doc read); extras live in the pack's own plugin-digest-wa-pitches.

import { waPitches } from './digest.mjs';

export const def = {
  name: 'wa_pitches',
  description: 'List the canned WhatsApp openers the digest composer offers: the canonical first-touch pitch (from the gtm pack\'s outreach-first-touch doc when installed) plus the extras in the plugin-digest-wa-pitches doc. Placeholders: {first_name}/{name}, {company}, {role}.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return waPitches(api);
}
