// Editorial plugin — save_osint_listener. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first). OSINT_SOURCES is
// imported from the lib so the def enum can never drift from the engines.

import { patchOsintListener, OSINT_SOURCES } from './osint.mjs';

export const def = {
  name: 'save_osint_listener',
  description: 'Enable, disable or re-cadence one scraper engine. Use for "turn on the github listener", "disable stackoverflow", "switch reddit to daily".',
  input_schema: {
    type: 'object',
    properties: {
      source:  { type: 'string', enum: OSINT_SOURCES },
      enabled: { type: 'boolean' },
      cadence: { type: 'string', enum: ['manual', 'daily', 'hourly'] },
      notes:   { type: 'string' },
    },
    required: ['source'],
  },
};

export async function run(api, input) {
  return { listener: await patchOsintListener(api, input.source, input) };
}
