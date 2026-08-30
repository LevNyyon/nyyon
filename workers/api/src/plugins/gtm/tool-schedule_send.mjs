// GTM plugin — schedule_send. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { scheduleSend } from './gtm-schedule.mjs';

export const def = {
  name: 'schedule_send',
  description: "SCHEDULE outreach bubbles to one lead's WhatsApp for a future moment (ms epoch). Fires on the first cron tick at or after send_at — up to ~40 minutes late, NEVER early, NEVER twice. Duplicates are structurally blocked: content identical to anything ever sent to this lead is refused, only one live schedule per lead+content, the runner claims atomically and fails closed. THIS WILL MESSAGE A REAL PERSON at the scheduled time — show the operator the exact bubbles and time and get an explicit yes first.",
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'lead id' },
      bubbles: { type: 'array', items: { type: 'string' }, description: 'max 4 — the playbook caps a touch at 4' },
      send_at: { type: 'number', description: 'ms epoch, future' },
    },
    required: ['id', 'bubbles', 'send_at'],
  },
};

export async function run(api, input) {
  const r = await scheduleSend(api, { lead_id: input?.id, bubbles: input?.bubbles, send_at: input?.send_at });
  // The lib names the row `id`; the shared context already carries a lead
  // `id`, so hand it back under a name that cannot be mistaken for one.
  return r?.error ? r : { ...r, schedule_id: r.id };
}
