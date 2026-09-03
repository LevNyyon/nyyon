// GTM plugin — save_lead.

import { saveLeadPatch } from './gtm.mjs';

export const def = {
  name: 'save_lead',
  description: "Write named fields onto a lead, with their provenance, conflicts, tombstones, step verdicts and any ICP verdict, then log the activity event. Coalesce-never-clobber: a field you do not pass is left alone, and an explicit null is a deliberate clear. Use edit_lead for an operator's hand correction of a single field.",
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
    actor: input.actor || 'operator',
  });
}
