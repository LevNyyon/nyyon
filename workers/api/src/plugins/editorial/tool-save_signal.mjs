// Editorial plugin — save_signal. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { patchSignal } from './heartbeat.mjs';

export const def = {
  name: 'save_signal',
  description: 'Patch one signal\'s status: "actioned" once it has produced an article or post (so it is never suggested again), "dismissed" when the operator waves it off.',
  input_schema: {
    type: 'object',
    properties: {
      signal_id: { type: 'string' },
      status:    { type: 'string', enum: ['new', 'scored', 'actioned', 'dismissed'] },
    },
    required: ['signal_id', 'status'],
  },
};

export async function run(api, input) {
  return { signal: await patchSignal(api, input.signal_id, { status: input.status }) };
}
