// Editorial plugin — cancel_hottake_schedule. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { readPackage, findPackageBySlug, cancelSchedule } from './hot-takes.mjs';

export const def = {
  name: 'cancel_hottake_schedule',
  description: 'Cancel a scheduled publication by package id or blog slug: the package returns to ready and queued legs go back to ready or draft with their times cleared. Nothing is deleted.',
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string' }, slug: { type: 'string' } },
    required: [],
  },
};

export async function run(api, input) {
  // Lookup only — cancelling must never CREATE a package for the slug.
  const pkg = input.id ? await readPackage(api, input.id) : await findPackageBySlug(api, input.slug);
  if (!pkg) return { error: 'no package found — nothing is scheduled for this publication' };
  return cancelSchedule(api, pkg.id, input.actor || 'operator');
}
