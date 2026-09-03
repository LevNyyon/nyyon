// GTM plugin — list_scheduled_sends. Ported verbatim from the host outreach
// tools (workers/api/src/tools/outreach.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { listScheduled, scheduleConfig } from './gtm-schedule.mjs';

export const def = {
  name: 'list_scheduled_sends',
  description: 'List scheduled sends (live + failed by default) with the schedule defaults from the gtm-schedule knowledge doc — the send hour, days-ahead, jitter and timezone the picker offers. Filter by lead; include_done:true adds sent and cancelled history. Read-only.',
  input_schema: {
    type: 'object',
    properties: {
      lead_id: { type: 'string' },
      include_done: { type: 'boolean', description: 'add sent/cancelled history' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return {
    schedules: await listScheduled(api, { lead_id: input?.lead_id || null, include_done: !!input?.include_done }),
    defaults: await scheduleConfig(api),
  };
}
