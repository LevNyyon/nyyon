// Editorial plugin — save_hottake_package. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { patchPackage, dismissPackage } from './hot-takes.mjs';

export const def = {
  name: 'save_hottake_package',
  description: 'Patch one Hot Takes package — the topic fields, the take and its four inputs, the headline, notes, pinned, or the status. Pass only the keys to change. status:"dismissed" retires the package (reversible by patching the status back).',
  input_schema: {
    type: 'object',
    properties: {
      id:             { type: 'string' },
      title:          { type: 'string' }, summary: { type: 'string' }, why_it_matters: { type: 'string' },
      take:           { type: 'string' }, believe: { type: 'string' }, misunderstood: { type: 'string' },
      who_cares:      { type: 'string' }, reader_action: { type: 'string' }, headline: { type: 'string' },
      company_notes:  { type: 'string' }, author_notes: { type: 'string' },
      status:         { type: 'string' }, pinned: { type: 'boolean' },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  const { id, actor, ...patch } = input || {};
  // Dismissal is its own transition on the bus, not a status write.
  if (patch.status === 'dismissed') return { package: await dismissPackage(api, id, actor || 'operator') };
  return { package: await patchPackage(api, id, patch, actor || 'operator') };
}
