// GTM plugin — lookup_company_from_linkedin. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { lookupCompanyFromLinkedin } from './gtm.mjs';

// Subject fallback: the lead the workflow already read, patched by whatever
// reconcile has decided so far. (Helper duplicated per tool file.)
const leadNow = (input) => ({ ...(input.lead || {}), ...(input.lead_patch || {}) });

export const def = {
  name: 'lookup_company_from_linkedin',
  description: "Read a person's current company and job title off their own name-verified LinkedIn result. Self-skips when there is no LinkedIn profile on file, or when company AND title are both already known. Saves nothing.",
  input_schema: {
    type: 'object',
    properties: { name: { type: 'string' }, linkedin: { type: 'string', description: "the PERSON's linkedin.com/in/ url" } },
    required: [],
  },
};

export async function run(api, input) {
  const l = leadNow(input);
  const li = await lookupCompanyFromLinkedin(api, {
    name: input.name || l.name || input.wa_name || null,
    linkedin: input.linkedin || l.linkedin || null,
    company: l.company || null,
    position: l.position || null,
  });
  return { li, ...li };
}
