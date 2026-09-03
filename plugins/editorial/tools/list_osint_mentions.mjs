// Editorial plugin — list_osint_mentions. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first). OSINT_SOURCES is
// imported from the lib so the def enum can never drift from the engines.

import { listMentions, OSINT_SOURCES } from './osint.mjs';

export const def = {
  name: 'list_osint_mentions',
  description: 'List the mentions and conversations the listeners harvested, filtered by target and/or source. Use to answer "what are people saying about X this week" or to mine quotes and sentiment.',
  input_schema: {
    type: 'object',
    properties: {
      target_id: { type: 'string' },
      source:    { type: 'string', enum: OSINT_SOURCES },
      limit:     { type: 'number', description: 'default 200' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return { mentions: await listMentions(api, input || {}) };
}
