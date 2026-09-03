// Editorial plugin — delete_osint_target. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { deleteOsintTarget } from './osint.mjs';

export const def = {
  name: 'delete_osint_target',
  description: 'Remove one monitored target and its mentions. Use sparingly — prefer leaving a stale target in place and simply not scraping it.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

export async function run(api, input) {
  await deleteOsintTarget(api, input.id);
  return { ok: true, id: input.id };
}
