// GTM plugin — update_api_limits. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.
// The limits doc is re-slugged plugin-gtm-api-limits inside lib/gtm-usage.mjs.

import { saveLimits } from './gtm-usage.mjs';

export const def = {
  name: 'update_api_limits',
  description: 'Update the paid-enrichment API limits (the gtm-api-limits knowledge doc): per provider monthly_limit / renewal_day (1-28) / warn_at_pct, plus twilio.balance_warn_usd. Pass only the fields to change. Use when the operator states their real plan caps or renewal dates.',
  input_schema: {
    type: 'object',
    properties: {
      pdl:     { type: 'object', properties: { monthly_limit: { type: 'number' }, renewal_day: { type: 'number' }, warn_at_pct: { type: 'number' } } },
      serpapi: { type: 'object', properties: { monthly_limit: { type: 'number' }, renewal_day: { type: 'number' }, warn_at_pct: { type: 'number' } } },
      twilio:  { type: 'object', properties: { balance_warn_usd: { type: 'number' } } },
    },
    required: [],
  },
};

export async function run(api, input) {
  return { limits: await saveLimits(api, input || {}) };
}
