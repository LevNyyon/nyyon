// Editorial plugin — list_osint_targets. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { listOsintTargets } from './osint.mjs';

export const def = {
  name: 'list_osint_targets',
  description: 'List the brands and companies we monitor, each with its domain, App Store id and mention rollups. Call before scraping or reading mentions so you know which target id to pass.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { targets: await listOsintTargets(api) };
}
