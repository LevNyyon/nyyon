// Editorial plugin — read_hottake_schedule. Surface entry point for the old
// GET /api/hot-takes/schedule route: the release calendar — every publication
// with its website + per-leg markers, an overall state, and the attention
// strip of things that need the operator.

import { scheduleView } from './hot-takes.mjs';

export const def = {
  name: 'read_hottake_schedule',
  description: 'The Hot Takes release schedule: each ready/scheduled/published package with website + social-leg markers (scheduled/overdue/done), an overall state, and the attention list (overdue, incomplete, awaiting review, unscheduled).',
  input_schema: {
    type: 'object',
    properties: { days: { type: 'number', description: 'window in days (default 30)' } },
    required: [],
  },
};

export async function run(api, input) {
  return scheduleView(api, { days: Number(input?.days) || 30 });
}
