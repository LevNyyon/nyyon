// GTM plugin — draft_angles. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { getLead, listOrgChart } from './gtm.mjs';
import { draftAnglesForLead } from './gtm-outreach.mjs';

const leadNow = (input) => ({ ...(input.lead || {}), ...(input.lead_patch || {}) });

export const def = {
  name: 'draft_angles',
  description: "Draft ranked outreach angles and WhatsApp message bubbles for a fully identified prospect, from the operator profile, the outreach playbook and the VERIFIED org chart. A DRAFT only — it never sends and never saves; sending stays an explicit, operator-approved action. Blocked while the company is unverified (org_status 'warn').",
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: [] },
};

export async function run(api, input) {
  const lead = input.lead ? leadNow(input) : (input.id ? await getLead(api, input.id) : null);
  if (!lead) return { angles_payload: null, error: 'no lead' };
  const org_people = Array.isArray(input.org_people) && input.org_people.length
    ? input.org_people
    : await listOrgChart(api, lead.id);
  return draftAnglesForLead(api, { lead, org_people });
}
