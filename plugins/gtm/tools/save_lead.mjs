// GTM plugin — save_lead. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { saveLeadPatch } from './gtm.mjs';

export const def = {
  name: 'save_lead',
  description: "Persist a reconciled lead patch: fields, provenance, conflicts, tombstones, step verdicts and any ICP verdict, then log the activity event. The only writer for an enriched lead — it writes exactly the keys reconcile_identity decided to write and leaves every other column alone.",
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      lead_patch: { type: 'object' },
      sources: { type: 'object' },
      conflicts: { type: 'array', items: { type: 'object' } },
      dismissed: { type: 'array', items: { type: 'string' } },
      steps: { type: 'array', items: { type: 'object' } },
      icp_fit: { type: 'string', enum: ['strong', 'medium', 'weak'] },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  return saveLeadPatch(api, {
    id: input.id || input.lead?.id,
    lead_patch: input.lead_patch || {},
    sources: input.sources || null,
    conflicts: input.conflicts || null,
    dismissed: input.dismissed || null,
    steps: input.steps || null,
    icp_fit: input.icp_fit || null,
    icp_reasons: input.icp_reasons || null,
    icp_gaps: input.icp_gaps || null,
    rejected_linkedin: input.rejected_linkedin || null,
    actor: input.actor || 'operator',
  });
}
