// Prospecting workflows — the outcomes the granular prospecting tools compose.
//
// The chain that used to live inside gtm_enrich_lead is now a step list you can
// read, re-run and edit. Ordering is the whole design: WhatsApp before the paid
// sources so PDL can self-skip, SERP after everything that could supply a name,
// reconcile after every source has spoken, and exactly one writer at the end.
//
// `optional: true` on the source lookups is error POLICY, not branching — a dead
// WhatsApp gateway or an expired LinkedIn session must be RECORDED (the step run
// carries the error, and reconcile_identity simply records no verdict for a
// source that never answered) rather than destroying the identity work the other
// sources did. The write steps stay fatal: a failed save must be loud.

export const workflows = [
  {
    slug: 'enrich-lead',
    name: 'Prospecting · enrich a lead',
    description: "One lead fully identified in accuracy order with provenance, conflicts, per-source step verdicts, a cached org chart and an ICP verdict. Sources self-skip (PDL once the identity is known, SERP without a sourced name, ICP without name+company+title), so the chain is linear with no branching. Run with {id}; the batch drain is the module looping this workflow while leads remain.",
    trigger: { kind: 'on-demand', note: 'module Intake tab per lead, or run_workflow with {id}' },
    steps: [
      { tool: 'read_lead' },
      { tool: 'lookup_wa_identity', optional: true },
      { tool: 'lookup_company_from_linkedin', optional: true },
      { tool: 'enrich_person_pdl', optional: true },
      { tool: 'lookup_line_twilio', optional: true },
      { tool: 'search_socials_serp', optional: true },
      { tool: 'fetch_org_chart', optional: true },
      { tool: 'reconcile_identity' },
      { tool: 'score_icp', optional: true },
      { tool: 'save_lead' },
      { tool: 'save_org_chart' },
    ],
  },
  {
    slug: 'company-context',
    name: 'Prospecting · company context',
    description: "Everything about the company behind a lead, cached on the lead: theorg org chart, LinkedIn headcount (the ICP's size band) and open roles. Partial by design — a failed leg is reported by its step verdict, never fatal, and save_lead's coalesce-never-clobber keeps the facts already on file. Run with {id}.",
    trigger: { kind: 'on-demand', note: 'Qualification tab (also looped per lead for a bulk pass); run_workflow with {id}' },
    steps: [
      { tool: 'read_lead' },
      { tool: 'fetch_org_chart', optional: true },
      { tool: 'fetch_company_profile', optional: true },
      { tool: 'fetch_open_roles', optional: true },
      { tool: 'reconcile_identity' },
      { tool: 'save_org_chart' },
      { tool: 'save_lead' },
    ],
  },
  {
    slug: 'qualify-lead',
    name: 'Prospecting · qualify a lead',
    description: 'An ICP verdict (strong/medium/weak plus reason and gap tags) grounded in the company facts already stored on the lead, persisted with a step verdict. Run company-context first for a verdict grounded in real company data instead of an inference from the brand name. Run with {id}.',
    trigger: { kind: 'on-demand', note: 'Nyo or the Qualification tab, after company-context; run_workflow with {id}' },
    steps: [
      { tool: 'read_lead' },
      { tool: 'score_icp' },
      { tool: 'save_lead' },
    ],
  },
  {
    slug: 'draft-outreach-angles',
    name: 'Prospecting · draft outreach angles',
    description: "Ranked outreach angles plus draft WhatsApp bubbles persisted for a fully identified lead, blocked while the company is unverified (org_status 'warn'). DRAFTS ONLY — sending stays behind the operator-approved send tools and is never chained here. Run with {id}.",
    trigger: { kind: 'on-demand', note: 'Outreach tab / Nyo, GREEN leads only; run_workflow with {id}' },
    steps: [
      { tool: 'read_lead' },
      { tool: 'draft_angles' },
      { tool: 'save_angles' },
    ],
  },
  {
    slug: 'clean-identity',
    name: 'Prospecting · clean a mismatched identity',
    description: 'One mismatched lead cleaned: the wrong-person LinkedIn cleared, the URL tombstoned so no future search can re-attach it, a visible conflict recorded, and the company/position that were derived from the wrong profile dropped. Pure reuse of the enrichment reconcile+save pair. Run once per mismatch reported by audit_identities, with {id}.',
    trigger: { kind: 'on-demand', note: 'per mismatch reported by audit_identities; run_workflow with {id}' },
    steps: [
      { tool: 'read_lead' },
      { tool: 'reconcile_identity', input: { clean_identity: true } },
      { tool: 'save_lead' },
    ],
  },
];
