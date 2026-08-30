// GTM plugin — enrich_person_pdl. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { enrichPersonPdl } from './gtm.mjs';

// Subject fallbacks (helpers duplicated per tool file — no tool-to-tool imports).
const leadPhone = (input) => input.phone || input.lead?.normalized_phone || input.lead?.phone || null;
const leadNow = (input) => ({ ...(input.lead || {}), ...(input.lead_patch || {}) });

export const def = {
  name: 'enrich_person_pdl',
  description: 'Enrich a phone-anchored person through People Data Labs (name, company, title, email, social profiles). PAID per call — it self-skips whenever a name and a company are already known, so run the free sources first. Saves nothing.',
  input_schema: {
    type: 'object',
    properties: { phone: { type: 'string' }, name: { type: 'string' }, region: { type: 'string' }, country: { type: 'string' } },
    required: [],
  },
};

export async function run(api, input) {
  const l = leadNow(input);
  const pdl = await enrichPersonPdl(api, {
    phone: leadPhone(input),
    name: input.name || l.name || input.wa_name || null,
    company: l.company || input.li_company || null,
    region: input.region || l.region || null,
    country: input.country || l.country || null,
  });
  return { pdl, ...pdl };
}
