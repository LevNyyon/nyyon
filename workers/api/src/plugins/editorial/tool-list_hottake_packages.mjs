// Editorial plugin — list_hottake_packages. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { listPackages } from './hot-takes.mjs';

export const def = {
  name: 'list_hottake_packages',
  description: 'List the Hot Takes publication packages — the editorial pipeline from selected topic through take, brief, article, review, ready, scheduled and published. Filter by status to answer "what is waiting on me".',
  input_schema: {
    type: 'object',
    properties: {
      statuses: { type: 'array', items: { type: 'string' }, description: 'topic|take|brief|article|review|ready|scheduled|published|complete' },
      limit:    { type: 'number' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return { packages: await listPackages(api, input || {}) };
}
