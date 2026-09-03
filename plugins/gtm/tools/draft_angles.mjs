// GTM plugin — draft_angles. Drafts, never saves and never sends.

import { getLead } from './gtm.mjs';
import { draftAnglesForLead } from './gtm-outreach.mjs';

const leadNow = (input) => ({ ...(input.lead || {}), ...(input.lead_patch || {}) });

export const def = {
  name: 'draft_angles',
  description: "Draft ranked outreach angles and WhatsApp message bubbles for a fully identified prospect, from the operator profile, the outreach playbook and whatever company context is on file. A DRAFT only — it never sends and never saves; sending stays an explicit, operator-approved action.",
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: [] },
};

export async function run(api, input) {
  const lead = input.lead ? leadNow(input) : (input.id ? await getLead(api, input.id) : null);
  if (!lead) return { angles_payload: null, error: 'no lead' };
  return draftAnglesForLead(api, { lead });
}
