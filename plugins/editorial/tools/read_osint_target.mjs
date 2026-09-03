// Editorial plugin — read_osint_target. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { readOsintTarget } from './osint.mjs';

export const def = {
  name: 'read_osint_target',
  description: 'Read one monitored target by id.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  const target = await readOsintTarget(api, input.id);
  return target ? { found: true, target } : { found: false };
}
