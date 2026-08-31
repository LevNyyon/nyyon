// GTM plugin — read_lead. Ported verbatim from workers/api/src/tools/prospecting.js;
// def and result shape unchanged, env replaced by the capability object.

import { getLead, leadState, evaluateConfidence, listOrgChart } from './gtm.mjs';
import { readAngles } from './gtm-outreach.mjs';

export const def = {
  name: 'read_lead',
  description: 'Read one prospect (GTM lead) with its derived state, confidence, cached org chart and stored outreach angles. Start every prospecting workflow here — the later steps read the lead off this result.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const lead = await getLead(api, input.id);
  if (!lead) return { error: 'not found' };
  return {
    lead: { ...lead, state: leadState(lead), confidence: evaluateConfidence(lead) },
    org_people: await listOrgChart(api, input.id),
    angles: await readAngles(api, input.id),
    // Stored people are not a fetch: save_org_chart must never replace live
    // rows with the copy it was just handed back.
    org_fetched: false,
  };
}
