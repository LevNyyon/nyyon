// GTM plugin — save_org_chart. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { saveOrgChart } from './gtm.mjs';

export const def = {
  name: 'save_org_chart',
  description: "Persist a freshly fetched org chart for a lead: replaces the stored people, copies their photos into permanent storage (theorg's expire), and stamps the org verdict on the lead. Skips itself when this run did not actually fetch a chart, so a failed lookup can never wipe a chart already on file.",
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      org_company: { type: 'string' },
      org_people: { type: 'array', items: { type: 'object' } },
      org_status: { type: 'string', enum: ['saved', 'warn', 'none'] },
      org_note: { type: 'string' },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  return saveOrgChart(api, {
    id: input.id || input.lead?.id,
    org_company: input.org_company || null,
    org_people: Array.isArray(input.org_people) ? input.org_people : [],
    org_status: input.org_status || null,
    org_note: input.org_note ?? null,
    theorg_slug: input.theorg_slug || null,
    org_fetched: input.org_fetched === true,
  });
}
