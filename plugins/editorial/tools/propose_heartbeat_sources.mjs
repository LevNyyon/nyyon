// Editorial plugin — propose_heartbeat_sources. Ported verbatim from the host
// Hot Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code
// in the pack's parallel lib (same function names, api first).

import { proposeSources } from './hottakes-setup.mjs';

export const def = {
  name: 'propose_heartbeat_sources',
  description: 'Scout the feeds and news queries this operator should watch, and VALIDATE every one by fetching it before offering it — only sources that really parsed come back, each with the item count seen. Reads what onboarding learned; returns reason:"no_material" (and proposes nothing) when the knowledge notes are still the shipped placeholders and no hint is given. Read-only: nothing is saved until save_hottakes_setup.',
  input_schema: {
    type: 'object',
    properties: {
      hint: { type: 'string', description: 'one line from the operator about what they do and who it is for — required when the knowledge notes are still generic' },
    },
    required: [],
  },
};

// Batch by nature: one scouting judgement, then N bounded fetches to prove
// each candidate. Splitting it per candidate would re-ask the model N times
// for the same list.
export async function run(api, input) {
  return proposeSources(api, { hint: input?.hint || '', actor: input?.actor || 'operator' });
}
