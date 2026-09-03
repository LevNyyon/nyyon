// Editorial plugin — save_hottakes_setup. Ported verbatim from the host Hot
// Takes tools (workers/api/src/tools/hottakes.js); env → api, shared code in
// the pack's parallel lib (same function names, api first).

import { applySetup } from './hottakes-setup.mjs';

export const def = {
  name: 'save_hottakes_setup',
  description: 'Commit the Hot Takes first run: add the chosen feed sources, add brand/competitor listeners, write the operator\'s own words into the heartbeat-priorities note, and record that this module has been set up so its first-run panel never opens unattended again. Everything is optional — saving with nothing chosen still closes the first run and leaves a working, empty module.',
  input_schema: {
    type: 'object',
    properties: {
      sources: {
        type: 'array',
        description: 'feeds to watch: {kind:"rss", name, url} or {kind:"gnews", name, query}',
        items: { type: 'object' },
      },
      targets: {
        type: 'array',
        description: 'names to listen for: {name, domain, kind:"plugin-editorial-brand"|"competitor"}',
        items: { type: 'object' },
      },
      watch: {
        type: 'object',
        description: 'the operator\'s own words: {topics:[], keywords:[], ignore:[], note}',
      },
      ran_ingest: { type: 'boolean', description: 'record that the first ingest was run as part of setup' },
    },
    required: [],
  },
};

export async function run(api, input) {
  return applySetup(api, {
    sources: input?.sources || [],
    targets: input?.targets || [],
    watch: input?.watch || null,
    ran_ingest: Boolean(input?.ran_ingest),
    actor: input?.actor || 'operator',
  });
}
