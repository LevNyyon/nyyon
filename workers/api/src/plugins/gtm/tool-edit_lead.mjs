// GTM plugin — edit_lead. The host had no tool for this: POST /api/gtm/leads/:id
// called lib manualEditLead directly (and mapped its throw to a 400 with the
// reason). Tools answer JSON, so a rejected value comes back as { error } and
// the surface's data layer re-throws it for the confirm popover to display.
// Result mirrors the route body: { lead } decorated with state + confidence.

import { manualEditLead, leadState, evaluateConfidence } from './gtm.mjs';

export const def = {
  name: 'edit_lead',
  description: "Manually edit one lead's fields (name / linkedin / email / company / position; '' clears a field), correct the company's LinkedIn page (company_linkedin — a targeted key, never a whole-socials rewrite), or set/clear company_staff_count. A manual edit stamps 'manual' provenance and resolves conflicts on the fields it touched. Returns the updated lead with its re-evaluated state and identity confidence.",
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      linkedin: { type: 'string' },
      email: { type: 'string' },
      company: { type: 'string' },
      position: { type: 'string' },
      socials: { type: 'array', items: { type: 'object' }, description: 'replace the socials array (removed URLs are tombstoned)' },
      company_linkedin: { type: ['string', 'null'], description: 'the COMPANY page URL; null/"" clears it and forgets what the old one resolved to' },
      company_staff_count: { type: ['number', 'string', 'null'], description: 'LinkedIn headcount override; null/"" clears it back to "not checked"' },
    },
    required: ['id'],
  },
};

export async function run(api, input) {
  const { id, ...patch } = input || {};
  if (!id) return { error: 'id required' };
  try {
    const lead = await manualEditLead(api, id, patch);
    return { lead: { ...lead, state: leadState(lead), confidence: evaluateConfidence(lead) } };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
