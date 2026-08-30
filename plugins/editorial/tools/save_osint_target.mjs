// Editorial plugin — save_osint_target. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { writeOsintTarget } from './osint.mjs';

export const def = {
  name: 'save_osint_target',
  description: 'Create or update a monitored target. Use for "monitor Acme", "also watch acme.io for them", "add their App Store id". Omit id to create.',
  input_schema: {
    type: 'object',
    properties: {
      id:     { type: 'string', description: 'omit to create' },
      name:   { type: 'string' },
      domain: { type: 'string' },
      app_id: { type: 'string', description: 'Apple App Store id, for the appstore listener' },
      notes:  { type: 'string' },
    },
    required: ['name'],
  },
};

export async function run(api, input) {
  return { target: await writeOsintTarget(api, { ...input, updated_by: input.actor || 'nyo' }) };
}
