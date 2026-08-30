// GTM plugin — qualify_lead. The host route POST /api/gtm/leads/:id/icp ran the
// qualify-lead WORKFLOW (pure score_icp + save_lead); a pack has no workflows,
// so this tool runs the pack lib's scoreIcpFit, which reads the lead's stored
// company facts, scores against the brand-icp knowledge doc, PERSISTS icp_fit +
// icp_reasons and records the run in the lead's step history. Distinct from the
// pure score_icp tool (host name, saves nothing) that the ported workflow seeds
// still call. Result: { fit, reasons[], gaps[] } | { error }.

import { scoreIcpFit } from './gtm.mjs';

export const def = {
  name: 'qualify_lead',
  description: 'Score one prospect against the editable brand-icp knowledge doc using their real company facts (headcount, open roles, org chart) and SAVE the verdict on the lead: strong / medium / weak plus 1-2 word reason and gap tags. Refuses without a name, company and title — a verdict without those is noise. Run company_context first for a grounded verdict.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  if (!input?.id) return { error: 'id required' };
  return scoreIcpFit(api, input.id);
}
