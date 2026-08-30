// GTM plugin — list_batches. The host had no tool for this: GET /api/gtm/batches
// called lib listBatches directly. A plugin surface drives its OWN tools through
// the invoke route, so the route's job becomes this tool (recipe rule: a REST
// route with logic not covered by an existing tool gets one, one job each).
// Result mirrors the route body: { batches } with per-batch new_count.

import { listBatches } from './gtm.mjs';

export const def = {
  name: 'list_batches',
  description: 'List the uploaded phone-list batches, newest first, each with its import tallies (total / created / duplicates / invalid) and new_count — how many of its leads are still un-enriched. new_count powers the surface auto-resume: a batch left half-enriched is picked back up on mount. Read-only.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return { batches: await listBatches(api) };
}
