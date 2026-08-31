// GTM plugin — read_api_usage. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.
// The read side of the meters update_api_limits writes — kept as a pool tool so
// the GTM Usage panel reads through the invoke route instead of past the pool.

import { gtmApiUsage } from './gtm-usage.mjs';

export const def = {
  name: 'read_api_usage',
  description: 'Read the paid-enrichment API meters: per provider (PDL, SerpApi, Twilio) the calls used this period, the configured monthly limit and renewal day, the warn threshold, and whether the cap is close. Read-only — edit the caps with update_api_limits.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return gtmApiUsage(api);
}
