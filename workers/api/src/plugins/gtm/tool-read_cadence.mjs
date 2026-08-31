// GTM plugin — read_cadence. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { loadCohortCadence } from './outreach-cadence.mjs';

export const def = {
  name: 'read_cadence',
  description: 'Read the cohort cadence rules (the outreach-cohort-cadence knowledge doc): step_delays_hours, max_sends_per_day, min_gap_minutes, quiet hours, weekdays_only, timezone, dead_after_days, require_approval and max_message_chars.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return loadCohortCadence(api);
}
