// GTM plugin — list_green_leads. greenLeads lives in gtm.mjs and
// greenLeadsWithStatus in gtm-outreach.mjs; lib files may not import each
// other, so THIS TOOL passes the rows between them.

import { greenLeads } from './gtm.mjs';
import { greenLeadsWithStatus } from './gtm-outreach.mjs';

export const def = {
  name: 'list_green_leads',
  description: 'List the fully identified (GREEN) prospects ready for qualification and outreach. Each row carries any stored angles and its contact status: not_contacted, contacted, or replied. Use to answer "who did I contact", "who replied", "who is still untouched".',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  const leads = await greenLeads(api);
  return { leads: await greenLeadsWithStatus(api, leads) };
}
