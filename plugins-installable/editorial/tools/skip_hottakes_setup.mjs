// Editorial plugin — skip_hottakes_setup. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { skipSetup, reopenSetup } from './hottakes-setup.mjs';

export const def = {
  name: 'skip_hottakes_setup',
  description: 'Record that the operator declined the Hot Takes first run. The module keeps working (empty, not broken) and the panel never opens on its own again. Pass reopen:true to undo — the setup can then be started again deliberately from Approved Sources.',
  input_schema: {
    type: 'object',
    properties: { reopen: { type: 'boolean', description: 'true = clear the decision so setup can be run again' } },
    required: [],
  },
};

export async function run(api, input) {
  return input?.reopen
    ? reopenSetup(api, { actor: input?.actor || 'operator' })
    : skipSetup(api, { actor: input?.actor || 'operator' });
}
