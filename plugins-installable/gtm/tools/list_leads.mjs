// GTM plugin — list_leads. The host had no tool for this: GET /api/gtm/leads
// called lib listLeads directly. Result mirrors the route body: { leads },
// every row decorated with state (completeness), confidence (identity),
// truecaller_url and the recorded per-step verdicts — the surface derives
// nothing the backend doesn't own.

import { listLeads } from './gtm.mjs';

export const def = {
  name: 'list_leads',
  description: 'List prospecting leads (capped at 500 rows), filterable by batch_id, status (new|enriched), stage (red|yellow|green) or a free-text q over name/company/phone. Each row carries state, identity confidence, truecaller_url and the recorded enrichment-step verdicts. Read-only.',
  input_schema: {
    type: 'object',
    properties: {
      batch_id: { type: 'string', description: 'only leads from this uploaded list' },
      status: { type: 'string', description: "'new' | 'enriched'" },
      stage: { type: 'string', description: "'red' | 'yellow' | 'green' — completeness stage" },
      q: { type: 'string', description: 'free text over name / company / phone' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return {
    leads: await listLeads(api, {
      batch_id: input?.batch_id || null,
      status: input?.status || null,
      stage: input?.stage || null,
      q: input?.q || null,
    }),
  };
}
