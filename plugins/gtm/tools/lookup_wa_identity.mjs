// GTM plugin — lookup_wa_identity. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { lookupWaIdentity } from './gtm.mjs';

// Every lookup accepts its subject explicitly but falls back to the lead the
// workflow already read, so a step is runnable standalone AND inside the chain.
// (Helper duplicated per tool file — the contract forbids tool-to-tool imports.)
const leadPhone = (input) => input.phone || input.lead?.normalized_phone || input.lead?.phone || null;

export const def = {
  name: 'lookup_wa_identity',
  description: "Look a phone number up on WhatsApp: registered?, display name, profile photo, about text, business flag. Read-only, nothing is sent and nothing is saved. Use as the first identity source for a new lead — it is free and the most accurate.",
  input_schema: { type: 'object', properties: { phone: { type: 'string' }, id: { type: 'string', description: 'lead id — the profile photo is copied into permanent storage under it' } }, required: [] },
};

export async function run(api, input) {
  const wa = await lookupWaIdentity(api, { phone: leadPhone(input), lead_id: input.id || input.lead?.id || null });
  return { wa, ...wa };
}
