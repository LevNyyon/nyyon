// GTM plugin — company_context. The host route POST /api/gtm/leads/:id/
// company-context ran the company-context WORKFLOW; a pack has no workflows, so
// this tool runs the same pass via the pack lib (companyContextForLead: theorg
// org chart + LinkedIn headcount + LinkedIn open roles, cached on the lead).
// Result mirrors what the surface reads: { company, org_people, org_status,
// org_note, staff_count, open_roles, errors[] } — partial by design, a failed
// leg is listed in errors while whatever landed is kept.

import { companyContextForLead } from './gtm.mjs';

export const def = {
  name: 'company_context',
  description: "Fetch everything about the COMPANY behind one lead in a single pass: theorg's org chart, LinkedIn's headcount and open roles. Cached on the lead — a row checked recently is skipped unless refresh:true. Partial by design: the legs fail independently and a failure is reported in errors[] while the facts already on file are kept. Feeds the ICP match.",
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      refresh: { type: 'boolean', description: 'ignore the cache and re-fetch every leg' },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  if (!input?.id) return { error: 'id required' };
  return companyContextForLead(api, input.id, { refresh: !!input.refresh });
}
