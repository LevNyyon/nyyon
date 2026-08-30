// GTM plugin — search_socials_serp. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { searchSocialsSerp } from './gtm.mjs';

const leadNow = (input) => ({ ...(input.lead || {}), ...(input.lead_patch || {}) });

export const def = {
  name: 'search_socials_serp',
  description: "Search the web for a named person's social profiles. Hard-gated on a name that came from a real source — never invent one. LinkedIn hits come back as UNATTACHED candidates: deciding which (if any) is really this person is reconcile_identity's job. Saves nothing.",
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string' }, region: { type: 'string' }, country: { type: 'string' } },
    required: [],
  },
};

export async function run(api, input) {
  const l = leadNow(input);
  const serp = await searchSocialsSerp(api, {
    name: input.name || l.name || input.wa_name || input.pdl_name || null,
    region: input.region || l.region || null,
    country: input.country || l.country || null,
  });
  return { serp, ...serp };
}
