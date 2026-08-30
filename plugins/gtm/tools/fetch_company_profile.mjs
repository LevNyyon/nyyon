// GTM plugin — fetch_company_profile. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { fetchCompanyProfile } from './gtm.mjs';

export const def = {
  name: 'fetch_company_profile',
  description: "Resolve a company on LinkedIn: its company id (what the jobs API needs) and its headcount (the size band the ICP is written in). Cached per lead behind the gtm-policy windows, so running it over a whole list only pays for rows never checked or gone stale. Saves nothing.",
  input_schema: {
    type: 'object',
    properties: {
      company: { type: 'string' },
      company_linkedin_url: { type: 'string', description: 'a linkedin.com/company/ page — beats the guessed slug' },
      refresh: { type: 'boolean', description: 'ignore the cache window and re-resolve' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return fetchCompanyProfile(api, {
    lead: input.lead || null,
    company: input.company || null,
    company_linkedin_url: input.company_linkedin_url || null,
    refresh: !!input.refresh,
  });
}
