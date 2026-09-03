// Editorial plugin — list_osint_listeners. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { listOsintListeners } from './osint.mjs';

export const def = {
  name: 'list_osint_listeners',
  description: 'List the scraper engines (hn, reddit, stackoverflow, github, appstore, website, duckduckgo) with their enabled state, cadence, last run and lifetime totals. Listeners are the HOW of monitoring; targets are the WHAT.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { listeners: await listOsintListeners(api) };
}
