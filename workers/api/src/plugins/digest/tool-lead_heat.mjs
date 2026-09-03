// Digest plugin — lead_heat. Ported from cmd's tools/digest.js pool.

import { computeHeat } from './lead-heat.mjs';

export const def = {
  name: 'lead_heat',
  description: 'How warm a lead is, 0-100, with the facts behind it (replies, accepted connection, WhatsApp conversation, their recent activity, our engagement; decays when quiet). Weights live in the plugin-gtm-lead-heat knowledge doc. Identify the person by prospect_id, phone, or name.',
  input_schema: {
    type: 'object',
    properties: { prospect_id: { type: 'string' }, phone: { type: 'string' }, name: { type: 'string' } },
  },
};

export async function run(api, input) {
  return computeHeat(api, input || {});
}
