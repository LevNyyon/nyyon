// GTM plugin — fetch_org_chart. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { fetchOrgChartFor } from './gtm.mjs';

const leadNow = (input) => ({ ...(input.lead || {}), ...(input.lead_patch || {}) });

export const def = {
  name: 'fetch_org_chart',
  description: "Fetch a company's real org chart (names, titles, reporting lines) from theorg.com. Pass theorg_slug to override the company match for namesake companies — a pasted theorg.com/org/… URL works too. Saves nothing; save_org_chart persists it.",
  input_schema: {
    type: 'object',
    properties: { company: { type: 'string' }, theorg_slug: { type: 'string' } },
    required: [],
  },
};

export async function run(api, input) {
  const l = leadNow(input);
  return fetchOrgChartFor(api, {
    company: input.company || l.company || input.li_company || input.pdl_company || null,
    slug: input.theorg_slug || l.theorg_slug || null,
  });
}
