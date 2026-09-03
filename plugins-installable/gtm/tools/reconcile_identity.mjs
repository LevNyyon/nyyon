// GTM plugin — reconcile_identity. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { reconcileIdentity } from './gtm.mjs';

export const def = {
  name: 'reconcile_identity',
  description: "Merge every raw source result gathered so far into ONE lead patch: fill-don't-overwrite precedence, per-field provenance, disagreements recorded as conflicts instead of overwritten, LinkedIn profiles verified against the name (namesakes rejected, tombstoned URLs never re-attached), a per-source step verdict, and the CEO-mismatch org warning. Decides only — save_lead writes. Pass clean_identity:true to instead tear down a LinkedIn that was confirmed to be the wrong person.",
  input_schema: {
    type: 'object',
    properties: {
      clean_identity: { type: 'boolean', description: 'true = clear the wrong-person LinkedIn, tombstone the URL, drop what was derived from it' },
    },
    required: [],
  },
};

// Pure decision step: no I/O — it reads the shared context and returns the
// patch, which is what makes it safe to re-run. reconcileIdentity is one of the
// lib's api-free pure exports, so the capability object is not passed through.
export async function run(api, input) {
  return reconcileIdentity(input);
}
