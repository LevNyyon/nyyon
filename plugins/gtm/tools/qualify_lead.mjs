// GTM plugin — qualify_lead. Scores against brand-icp and SAVES the verdict.

import { scoreIcpFit } from './gtm.mjs';

export const def = {
  name: 'qualify_lead',
  description: 'Score one prospect against the editable brand-icp knowledge doc using the company facts on file, and SAVE the verdict on the lead: strong / medium / weak plus 1-2 word reason and gap tags. Refuses without a name, company and title — a verdict without those is noise. Run company_context first for a grounded verdict.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  if (!input?.id) return { error: 'id required' };
  return scoreIcpFit(api, input.id);
}
