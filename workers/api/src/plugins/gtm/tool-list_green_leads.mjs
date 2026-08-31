// GTM plugin — list_green_leads. Ported from workers/api/src/tools/prospecting.js;
// def and result shape unchanged. One port note: the host greenLeadsWithStatus(env)
// fetched the green leads itself; lib files may not import each other, so the
// ported lib takes the leads as an argument and THIS TOOL fetches them
// (contract v2.1: the tool passes results between libs). Merged rows identical.

import { greenLeads } from './gtm.mjs';
import { greenLeadsWithStatus } from './gtm-outreach.mjs';

export const def = {
  name: 'list_green_leads',
  description: 'List the fully identified (GREEN) prospects ready for qualification and outreach. Each row carries warm-contact flags, any stored angles, and its contact status: not_contacted, contacted, or replied. Use to answer "who did I contact", "who replied", "who is still untouched".',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  const leads = await greenLeads(api);
  return { leads: await greenLeadsWithStatus(api, leads) };
}
