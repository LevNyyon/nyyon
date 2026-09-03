// GTM plugin — run_due_sends. Ported verbatim from the host outreach tools
// (workers/api/src/tools/outreach.js); env → api, shared code in the pack's
// parallel lib (same function names, api first).

import { runDueSends } from './gtm-schedule.mjs';

export const def = {
  name: 'run_due_sends',
  description: 'Run the scheduled-send tick now (the same pass the cron runs): claim every due schedule atomically and deliver it. Safe to call repeatedly — a claim is one-shot and a second run can never duplicate a send. Returns how many were claimed, sent, partial and failed.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return runDueSends(api);
}
