// GTM plugin — company_context. The company behind a lead, from the sources
// this install has: a SerpApi search plus a read of the company's own site.

import { companyContextForLead } from './gtm.mjs';

export const def = {
  name: 'company_context',
  description: "Look up the COMPANY behind one lead: search for it, read its own site, and store a short fact sheet (what it does, industry, HQ, website, headcount when the page states one) on the lead. Needs SerpApi connected. Cached for 30 days unless refresh:true. Partial by design — whatever was found is kept and whatever failed is named in errors[]. Feeds the ICP match.",
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      refresh: { type: 'boolean', description: 'ignore the cache and look it up again' },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  if (!input?.id) return { error: 'id required' };
  return companyContextForLead(api, input.id, { refresh: !!input.refresh });
}
