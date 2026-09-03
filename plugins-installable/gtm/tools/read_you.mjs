// GTM plugin — read_you. Ported verbatim from workers/api/src/tools/prospecting.js;
// def and result shape unchanged. The operator profile doc is re-slugged
// plugin-gtm-you inside the lib (host slug gtm-you migrated by the pack migration).

import { readYou } from './gtm.mjs';

export const def = {
  name: 'read_you',
  description: "Read the operator profile the outreach drafting runs on: name, role, business (the positioning line), location, WhatsApp groups and the mutuals a draft is allowed to name. It lives in the plugin-gtm-you knowledge doc — edit it there or with write_knowledge, not here.",
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { you: await readYou(api) };
}
