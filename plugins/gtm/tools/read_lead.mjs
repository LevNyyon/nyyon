// GTM plugin — read_lead. One prospect with everything derived on read.

import { getLead, leadState, evaluateConfidence } from './gtm.mjs';
import { readAngles } from './gtm-outreach.mjs';

export const def = {
  name: 'read_lead',
  description: 'Read one prospect (GTM lead) with its derived completeness state, identity confidence and stored outreach angles. Start here — every other prospecting step reads the lead off this result.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const lead = await getLead(api, input.id);
  if (!lead) return { error: 'not found' };
  return {
    lead: { ...lead, state: leadState(lead), confidence: evaluateConfidence(lead) },
    angles: await readAngles(api, input.id),
  };
}
