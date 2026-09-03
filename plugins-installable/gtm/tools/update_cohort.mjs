// GTM plugin — update_cohort. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); def and result shape unchanged, env
// replaced by the capability object, shared code in the pack lib.

import { updateCohort } from './outreach-cohorts.mjs';

export const def = {
  name: 'update_cohort',
  description: "Change a cohort's settings: name, status (active | paused | finished | canceled), timezone, start_hour/end_hour, send_days (0=Sunday…6=Saturday), send_windows and languages. STATUS GATES THE SENDER — anything other than active stops every scheduled message inside that cohort at once, without moving anyone or losing their place in the ladder. Window fields are the cohort's own; leave them unset to inherit the account default from the cadence doc.",
  input_schema: {
    type: 'object',
    properties: {
      cohort_id: { type: 'string' },
      name: { type: 'string' },
      status: { type: 'string', description: 'active | paused | finished | canceled' },
      timezone: { type: 'string', description: 'IANA zone, e.g. Asia/Jerusalem. Empty string clears it.' },
      start_hour: { type: 'number' },
      end_hour: { type: 'number' },
      send_days: { type: 'array', items: { type: 'number' }, description: '0=Sunday … 6=Saturday. Superseded by send_windows when that is set.' },
      send_windows: {
        type: 'object',
        description: 'Eligible sending times per weekday, to the minute, in the cohort timezone: {"1":{"start":"09:00","end":"17:30"}} where 0=Sunday. A weekday that is ABSENT sends nothing. Overrides start_hour/end_hour and send_days entirely. Pass {} to clear it and inherit the account default window.',
      },
      languages: { type: 'array', items: { type: 'string' } },
    },
    required: ['cohort_id'],
  },
};

export async function run(api, input) {
  return updateCohort(api, input || {});
}
