// GTM plugin — lookup_line_twilio. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { lookupLineTwilio } from './gtm.mjs';

const leadPhone = (input) => input.phone || input.lead?.normalized_phone || input.lead?.phone || null;

export const def = {
  name: 'lookup_line_twilio',
  description: "Look up a phone number's line type (mobile / landline / voip), carrier and caller-ID name through Twilio. Billed per lookup. Saves nothing.",
  input_schema: { type: 'object', properties: { phone: { type: 'string' } }, required: [] },
};

export async function run(api, input) {
  const twilio = await lookupLineTwilio(api, { phone: leadPhone(input) });
  return { twilio, ...twilio };
}
