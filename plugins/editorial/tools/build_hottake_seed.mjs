// Editorial plugin — build_hottake_seed. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { buildArticleSeed } from './hot-takes.mjs';

export const def = {
  name: 'build_hottake_seed',
  description: 'Assemble the article seed for a package: deterministic prose built from the approved take, the brief and the playbook\'s Article instruction. No model, no writes — hand the result straight to the article writer.',
  input_schema: {
    type: 'object',
    properties: {
      id:    { type: 'string' },
      voice: { type: 'string', enum: ['personal', 'house'], description: 'default personal' },
    },
    required: ['id'],
  },
};

// title/body/voice are exactly the keys the shared article writer reads.
export async function run(api, input) {
  return { ...(await buildArticleSeed(api, input.id)), voice: input.voice || 'personal' };
}
