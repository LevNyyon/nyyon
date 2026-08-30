// Editorial plugin — schedule_hottake_release. Ported verbatim from the host
// Hot Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code
// in the pack's parallel lib (same function names, api first).

import { ensurePackageForSlug, scheduleRelease } from './hot-takes.mjs';

export const def = {
  name: 'schedule_hottake_release',
  description: 'Schedule a publication: the website publish plus a time for each LinkedIn leg. Pass the package id or a blog slug (a plain draft is adopted automatically). Times are ms epochs; anything omitted takes the recommended offset from the hottakes-timing note, and a reschedule preserves each leg\'s current gap from the publish.',
  input_schema: {
    type: 'object',
    properties: {
      id:          { type: 'string', description: 'package id' },
      slug:        { type: 'string', description: 'blog slug — used when there is no package yet' },
      website_at:  { type: 'number', description: 'ms epoch for the website publish' },
      company_at:  { type: 'number' },
      personal_at: { type: 'number' },
    },
    required: [],
  },
};

export async function run(api, input) {
  const id = input.id || (input.slug ? (await ensurePackageForSlug(api, input.slug, input.actor || 'operator')).id : null);
  if (!id) return { error: 'pass id or slug' };
  // Booking a time is NOT approving a post: the lib deliberately leaves each
  // leg in draft/ready, so only an explicit per-post approval can promote it
  // to 'scheduled' (the state the due-scan fires).
  return scheduleRelease(api, id, input || {}, input.actor || 'operator');
}
