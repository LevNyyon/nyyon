// GTM plugin — the Prospecting surface's data layer.
//
// A plugin surface drives its OWN plugin's tools through the scoped invoke
// route, so the page, the cron and the chat personas write through the exact
// same verbs and can never diverge. The types travel with the module.

// ── types (moved from web/src/lib/api.ts — the GTM slice the page reads) ─────

export type GtmLeadStage = 'red' | 'yellow' | 'green';
// One step's verdict, recorded at enrich time. `skipped` is a first-class
// outcome, not a failure: PDL skips itself when name+company are already known,
// LinkedIn without a linkedin on file, SerpApi without a sourced name.
export type GtmStepStatus = 'found' | 'empty' | 'skipped' | 'error';
export type GtmStep = { key: string; label: string; status: GtmStepStatus; reason: string | null; at: number };
// Identity-consistency signal, derived on read (re-evaluated on every enrich /
// manual edit). Distinct from `state`, which measures completeness.
export type GtmConfidenceFlag = { severity: 'high' | 'medium' | 'low'; label: string; detail: string };
export type GtmConfidence = { score: number; level: 'green' | 'yellow' | 'red'; flags: GtmConfidenceFlag[]; positives: string[] };

export type GtmLead = {
  id: string;
  phone: string;
  normalized_phone: string | null;
  status: 'new' | 'enriched';
  source: string | null;
  batch_id: string | null;
  country: string | null;
  region: string | null;
  name: string | null;
  photo: string | null;
  socials: string;            // JSON [{type,url,src,at}]
  linkedin: string | null;
  email: string | null;
  company: string | null;
  position: string | null;
  line_type: string | null;
  carrier: string | null;
  sources: string;            // JSON {field:{tool,at}}
  conflicts: string;          // JSON [{field,value,tool,at}]
  dismissed: string;          // JSON [url]
  active_tool: string | null;
  icp_fit: 'strong' | 'medium' | 'weak' | null;
  icp_reasons: string | null; // JSON {reasons:[],gaps:[]}
  // Company facts from the company-context pass. null = never checked, NOT
  // zero — the ICP scorer is told to read it that way too.
  company_staff_count: number | null;
  company_context: string | null;    // JSON {summary,industry,hq,website,staff_count,at}
  company_checked_at: number | null;
  outreach_lang: string | null;
  created_at: number;
  updated_at: number;
  state?: GtmLeadStage;
  confidence?: GtmConfidence;
  truecaller_url?: string | null;
  // What each enrichment step actually did, in chain order. null on leads
  // enriched before step recording (the page falls back to inferring from
  // provenance for those).
  steps?: GtmStep[] | null;
};

export type GtmBatch = { id: string; source: string | null; via: string; total: number; created: number; duplicates: number; invalid: number; created_at: number; new_count?: number };
export type GtmImportResult = { total: number; valid: number; invalid: number; duplicates: number; created: number; batch_id: string | null; via: string };

export type GtmAngle = { rank: number; target: string; type: string; rationale: string; messages: string[]; confidence: 'low' | 'medium' | 'high'; missing?: string };
export type GtmAngles = { playbook_fit: { language?: string; channel?: string; why?: string } | null; connection_points: { type: string; detail: string; strength: string }[]; angles: GtmAngle[]; blocked?: string; angles_at?: number };
export type GtmContactStatus = 'not_contacted' | 'contacted' | 'replied';
export type GtmGreenLead = GtmLead & {
  angles: GtmAngles | null;
  contact_status?: GtmContactStatus;
  first_contacted_at?: number | null;
  last_contacted_at?: number | null;
  sends?: number;
  replied_at?: number | null;
};

// ── the invoke route ─────────────────────────────────────────────────────────

async function invoke<T>(tool: string, input: unknown): Promise<T> {
  const r = await fetch(`/api/plugins/gtm/invoke/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.result as T;
}

// ── the helpers the page calls (names and shapes identical to lib/api.ts) ────

export const api = {
  gtmBatches: () =>
    invoke<{ batches: GtmBatch[] }>('list_batches', {}).then((r) => r.batches),
  gtmLeads: (opts: { batch_id?: string; status?: string; stage?: string; q?: string } = {}) =>
    invoke<{ leads: GtmLead[] }>('list_leads', opts).then((r) => r.leads),
  gtmImport: (body: { text?: string; url?: string; source?: string }) =>
    invoke<GtmImportResult>('import_leads', body),
  gtmEnrichBatch: (batch_id: string, limit = 2) =>
    invoke<{ enriched: number; remaining: number }>('enrich_batch', { batch_id, limit }),
  // The tool answers { error } instead of an HTTP 400 (JSON in, JSON out) — the
  // rejection is re-thrown here so the confirm popover's catch shows the reason
  // exactly as it did against the old route.
  gtmEditLead: (id: string, patch: Partial<Pick<GtmLead, 'name' | 'linkedin' | 'email' | 'company' | 'position'>> & { socials?: { type: string; url: string }[]; company_staff_count?: number | null; company_linkedin?: string | null }) =>
    invoke<{ lead?: GtmLead; error?: string }>('edit_lead', { id, ...patch }).then((r) => {
      if (r.error || !r.lead) throw new Error(r.error || 'edit failed');
      return r.lead;
    }),
  // 'resume' re-runs only the steps a manual edit can unblock (SerpApi + the
  // finalize LinkedIn pass), leaving the paid per-lookup legs alone.
  gtmEnrichLead: (id: string, kind?: 'full' | 'resume') =>
    invoke<Record<string, unknown>>('enrich_lead', { id, kind: kind || 'full' }),
  gtmScoreIcp: (id: string) =>
    invoke<{ fit?: string; reasons?: string[]; gaps?: string[]; error?: string }>('qualify_lead', { id }),
  // Search the company and read its own site, in one pass. Partial by design:
  // `errors` lists what failed while whatever was found is still kept.
  gtmCompanyContext: (id: string, opts: { refresh?: boolean } = {}) =>
    invoke<{
      company?: string; staff_count?: number | null; summary?: string | null;
      industry?: string | null; hq?: string | null; website?: string | null;
      errors?: string[]; error?: string;
    }>('company_context', { id, refresh: !!opts.refresh }),
  gtmGreen: () =>
    invoke<{ leads: GtmGreenLead[] }>('list_green_leads', {}).then((r) => r.leads),
};
