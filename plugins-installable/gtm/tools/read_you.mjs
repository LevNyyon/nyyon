// GTM plugin — read_you. Ported verbatim from workers/api/src/tools/prospecting.js;
// def and result shape unchanged. The operator profile doc is re-slugged
// plugin-gtm-you inside the lib (host slug gtm-you migrated by the pack migration).

import { readYou } from './gtm.mjs';

export const def = {
  name: 'read_you',
  description: "Read the operator profile that drives outreach positioning and warm-path matching (name, role, business, location, WhatsApp groups, warm connections). It lives in the gtm-you knowledge doc — edit it with write_knowledge, not here.",
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { you: await readYou(api) };
}
