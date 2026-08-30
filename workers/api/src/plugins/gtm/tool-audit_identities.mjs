// GTM plugin — audit_identities. Ported verbatim from
// workers/api/src/tools/prospecting.js; def and result shape unchanged.

import { auditLinkedinIdentity } from './gtm.mjs';

export const def = {
  name: 'audit_identities',
  description: "Audit every prospect whose assigned LinkedIn profile does not match their name (the namesake / wrong-person bug) and report match / unverifiable / mismatch. REPORT ONLY — fixing a mismatch is the clean-identity workflow, run once per reported lead. Use after big imports, or whenever a LinkedIn assignment looks wrong.",
  input_schema: { type: 'object', properties: {}, required: [] },
};

export async function run(api) {
  return auditLinkedinIdentity(api, { fix: false });
}
