// Editorial plugin — ingest_signals. Ported verbatim from the host Hot Takes
// tools (workers/api/src/tools/hottakes.js); env → api, shared code in the
// pack's parallel lib (same function names, api first).

import { ingestHeartbeat } from './heartbeat.mjs';

export const def = {
  name: 'ingest_signals',
  description: 'Pull every enabled feed and insert the items we have not seen before as unscored signals. The read half of the awareness sweep — it never judges anything.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

// Batch by nature: one pass over N feeds, deduped by URL inside the lib.
export async function run(api) {
  const r = await ingestHeartbeat(api);
  return { inserted: r.inserted, per_source: r.perSource };
}
