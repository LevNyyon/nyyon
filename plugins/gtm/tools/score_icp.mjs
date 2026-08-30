// GTM plugin — score_icp. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { getLead, scoreIcpFromFacts } from './gtm.mjs';

const leadNow = (input) => ({ ...(input.lead || {}), ...(input.lead_patch || {}) });

export const def = {
  name: 'score_icp',
  description: 'Score a prospect against the editable brand-icp knowledge doc using their real company facts (headcount, open roles, org chart): strong / medium / weak plus short reason and gap tags. Refuses without a name, company and title — a verdict without those is noise. Saves nothing.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: [] },
};

export async function run(api, input) {
  // Score the RECONCILED identity: inside enrich-lead the patch is newer
  // than the row it came from, and a lead identified this run should be
  // scored this run rather than on the next pass.
  const lead = input.lead ? leadNow(input) : (input.id ? await getLead(api, input.id) : null);
  if (!lead) return { error: 'no lead' };
  return scoreIcpFromFacts(api, {
    lead,
    org_people: Array.isArray(input.org_people) ? input.org_people : [],
    staff_count: input.staff_count ?? input.company_profile?.staff_count ?? null,
    positions: Array.isArray(input.positions) ? input.positions : null,
  });
}
