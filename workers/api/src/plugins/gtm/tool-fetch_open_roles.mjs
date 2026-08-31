// GTM plugin — fetch_open_roles. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { fetchOpenRoles } from './gtm.mjs';

export const def = {
  name: 'fetch_open_roles',
  description: "Fetch a company's currently open roles. NOT available through the current LinkedIn provider (Unipile) — the call fails cleanly and enrichment treats it as an optional, skipped step. Kept for providers that support it.",
  input_schema: { type: 'object', properties: { company_id: { type: 'string' } }, required: [] },
};

export async function run(api, input) {
  return fetchOpenRoles(api, { company_id: input.company_id || input.lead?.company_li_id || null });
}
