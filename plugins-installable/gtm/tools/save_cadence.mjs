// GTM plugin — save_cadence. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { saveCohortCadence } from './outreach-cadence.mjs';

export const def = {
  name: 'save_cadence',
  description: 'Change the cohort cadence rules (the outreach-cohort-cadence knowledge doc). Pass only what changes. require_approval is the master gate: while true the sender refuses any message the operator has not individually approved — turning it off makes every scheduled message send unattended, so confirm that explicitly before doing it.',
  input_schema: {
    type: 'object',
    properties: {
      step_delays_hours: { type: 'array', items: { type: 'number' } },
      max_sends_per_day: { type: 'number' },
      min_gap_minutes: { type: 'number' },
      quiet_start_hour: { type: 'number' },
      quiet_end_hour: { type: 'number' },
      weekdays_only: { type: 'boolean' },
      timezone: { type: 'string' },
      dead_after_days: { type: 'number' },
      require_approval: { type: 'boolean', description: 'the single switch that can hold every send' },
      max_message_chars: { type: 'number' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return saveCohortCadence(api, input || {});
}
