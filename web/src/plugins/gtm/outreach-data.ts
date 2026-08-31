// GTM plugin — the Outreach surface's data layer.
//
// The host REST routes this page used to call (/api/outreach/*, /api/wa/send,
// /api/gtm/leads/:id, /api/gtm/schedules) are gone with the module: a plugin
// surface drives its OWN plugin's tools through the scoped invoke route, so
// the page, the crons and Nyo all write through the exact same verbs and can
// never diverge. The types travel with the module too — they used to live in
// web/src/lib/api.ts, which the conversion strips of its GTM section.
//
// Two of the old routes fronted WORKFLOWS (draft-prospect-reply and
// outreach-cohort-tick); those ship as the pack's draft_prospect_reply and
// run_cohort_tick tools, same result shapes. The old /api/outreach/cohort/
// control action-string fans out to pause_member / stop_member /
// unschedule_member exactly like the route did.

// ── Outreach · WA — the prospect inbox ─────────────────────────────────────
// A conversation row in the WA tab. `uncaught` = they spoke last, so the ball
// is in our court; those pin to the top of the list.
export type OutreachStatus = 'active' | 'unanswered' | 'dead' | 'fresh' | 'scheduled';
export type OutreachCounts = Record<OutreachStatus, number>;
export type OutreachThread = {
  chat_id: string; lead_id: string;
  scheduled_text?: string | null; scheduled_at?: number | null;
  name: string | null; company: string | null; position: string | null;
  photo: string | null; icp_fit: string | null;
  last_text: string | null; last_from_me: boolean | null; last_at: number | null;
  uncaught: boolean; never_messaged: boolean; answered: boolean;
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  msgs_in: number | null; msgs_out: number | null;
  status: OutreachStatus;
  dead_marked: boolean; dead_reason: string | null;
  dead_by: 'marked' | 'stale' | null;
};

// A cohort's run state. Anything other than 'active' stops the sender for
// everyone inside it, without moving anyone or losing their place.
export type CohortStatus = 'active' | 'paused' | 'finished' | 'canceled';
export const COHORT_STATUSES: CohortStatus[] = ['active', 'paused', 'finished', 'canceled'];
// Only WhatsApp actually sends; the rest are selectable so a flow can be
// designed ahead of the plumbing.
export const OUTREACH_CHANNELS = ['whatsapp', 'linkedin', 'email'] as const;
export const OUTREACH_WIRED_CHANNELS: readonly string[] = ['whatsapp'];
export const OUTREACH_TRIGGERS = ['no_reply', 'always'] as const;
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type OutreachCohort = {
  id: string; name: string; note: string | null; created_at: number;
  status: CohortStatus;
  // The cohort's own sending window. null = inherit the account default.
  timezone: string | null;
  start_hour: number | null;
  end_hour: number | null;
  send_days: number[] | null;   // 0=Sunday … 6=Saturday
  // Eligible sending times per weekday, to the minute, in `timezone`. A weekday
  // that is ABSENT sends nothing. Overrides start_hour/end_hour and send_days.
  send_windows: Record<string, { start: string; end: string }> | null;
  languages: string[] | null;
  has_sequence: boolean;
  total: number; active: number; answered: number;
};

// The cohort's message sequence. Written once for the whole queue; the only
// per-person variation is variable substitution and which language variant.
export type OutreachSequenceStep = {
  delay_hours: number;
  channel: string;
  trigger: string;
  bodies: Record<string, string>;   // language code -> text
};
export type OutreachSequence = {
  default_language: string;
  steps: OutreachSequenceStep[];
};
export type OutreachSequenceInfo = {
  cohort_id: string;
  sequence: OutreachSequence;
  steps: number;
  languages: string[];
  variables_used: string[];
  unknown_variables: string[];
  ok: boolean;
};
export type OutreachGoLiveResult = {
  requested: number;
  live: { lead_id: string; name: string | null; steps: number; first_text: string | null }[];
  blocked: { lead_id: string; name?: string | null; reason: string }[];
  error?: string;
};
// Variables a sequence body may use — mirrors VARIABLES in the pack's
// outreach-cohorts lib.
export const OUTREACH_VARIABLES = ['first_name', 'name', 'company', 'position', 'country'] as const;

// One enrolled prospect on the automated ladder.
export type OutreachCohortMember = {
  lead_id: string; chat_id: string | null;
  cohort_id: string; cohort_name: string | null;
  staged: boolean; approved_at: number | null;
  blocked: string | null;
  name: string | null; company: string | null; position: string | null;
  photo: string | null; icp_fit: string | null;
  status: 'staged' | 'active' | 'answered' | 'paused' | 'done' | 'stopped';
  answered: boolean; answered_at: number | null;
  step: number; ladder_length: number;
  sent_count: number;
  last_sent_text: string | null; last_sent_at: number | null;
  next_text: string | null; next_send_at: number | null;
  next_state: 'draft' | 'scheduled' | null;
  next_step: number | null;
  next_send_label: string | null; next_send_zone: string | null;
  next_send_ymd: string | null; timezone: string;
  due_today: boolean;
  approved: boolean; approved_step: number | null; approved_step_at: number | null;
  approval_required: boolean;
  edited: boolean; override_text: string | null; override_blocked: string | null;
  conversation: 'untouched' | 'touched' | 'active' | 'dead';
  conversation_last_at: number | null;
  dead_by: 'marked' | 'stale' | null;
  msgs_in: number; msgs_out: number;
  exhausted: boolean; stop_reason: string | null; last_error: string | null;
};
// What a bulk edit does to people already in the cohort. 'new_only' leaves
// hand-written per-person messages alone; 'everyone' overwrites them.
export type SequenceScope = 'new_only' | 'everyone';
export type OutreachApproveResult = {
  approved: { lead_id: string; name?: string | null; step?: number; approved: boolean }[];
  refused: { lead_id: string; name?: string | null; reason: string }[];
  error?: string;
};
export type OutreachTickResult = {
  ran: boolean; reason?: string; dry_run?: boolean; live?: boolean;
  due?: number; sent?: number; next_open?: number;
  results?: { lead_id: string; name?: string | null; action: string; text?: string; step?: number; error?: string }[];
};
// Everything the side panel shows about the person and their company.
export type OutreachProspect = {
  lead_id: string;
  name: string | null; company: string | null; position: string | null;
  photo: string | null; phone: string | null; email: string | null;
  linkedin: string | null; company_linkedin: string | null;
  company_staff_count: number | null;
  country: string | null; region: string | null;
  icp_fit: string | null; icp_reasons: string[]; icp_gaps: string[];
  org_status: string | null; org_note: string | null;
  open_positions: { title?: string; location?: string; url?: string; posted_at?: string }[];
  socials: { type: string | null; url: string }[];
  status: string | null;
};
// status: 'sent' = we asked WhatsApp to send it (one tick); 'confirmed' =
// WhatsApp echoed it back (two ticks); 'received' = theirs, no tick.
export type OutreachMessage = {
  id: string; from_me: boolean; body: string; sender_name: string | null; at: number | null;
  status: 'sent' | 'confirmed' | 'received';
};
export type OutreachThreadDetail = {
  chat_id: string;
  chat_ids?: string[];
  prospect: OutreachProspect | null;
  messages: OutreachMessage[];
  count: number;
  stats: {
    replied: boolean; uncaught: boolean;
    msgs_in: number | null; msgs_out: number | null;
    sentiment: string | null; sentiment_reason: string | null;
  } | null;
  error?: string;
};
// source: 'angle' = the approved GTM bubble verbatim (first touch);
// 'llm' = composed from that angle + the thread; 'none' = nothing to suggest.
export type OutreachDraft = {
  draft: string | null;
  source: 'angle' | 'llm' | 'template' | 'none';
  lead_id?: string;
  reason?: string;
  step?: number;
  first_touch?: boolean;
  angle?: { rank: number | null; type: string | null; rationale: string | null } | null;
  alternatives?: string[];
  based_on_messages?: number;
  at?: number;
  error?: string;
};

// ── the org chart behind the prospect card ─────────────────────────────────
// The same D1-column shape the old /api/gtm/leads/:id route answered with.
export type GtmOrgPerson = {
  id?: string; lead_id?: string; company?: string | null;
  node_id: string | null; parent_node_id: string | null;
  name: string | null; role: string | null;
  photo_url: string | null; report_count: number | null;
};
// The slice of the green-lead row GtmOrgChart actually reads (name to
// highlight, company for the empty state, contacts to mark in green).
export type GtmGreenLead = {
  name: string | null;
  company: string | null;
  contacts?: { name?: string | null; role?: string | null }[];
};

export type ScheduledSendRow = { id: string; lead_id: string; bubbles: string[]; send_at: number; status: string; error?: string | null };
export type ScheduleDefaultsRow = { default_send_hour?: number; default_days_ahead?: number; default_jitter_minutes?: number; timezone?: string };

// ── the invoke pipe ────────────────────────────────────────────────────────
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

// read_lead hands back org_people in theorg's shape (nodeId/parentId/photo/
// reportCount); the org chart reads the D1 column names. Same mapping the old
// /api/gtm/leads/:id route applied, so the {lead, org, angles} contract holds.
function orgRowsFromToolShape(people: unknown): GtmOrgPerson[] {
  return ((people as Record<string, unknown>[]) || []).map((p) => ({
    node_id: (p.nodeId ?? p.node_id ?? null) as string | null,
    parent_node_id: (p.parentId ?? p.parent_node_id ?? null) as string | null,
    name: (p.name ?? null) as string | null,
    role: (p.role ?? null) as string | null,
    photo_url: (p.photo ?? p.photo_url ?? null) as string | null,
    report_count: (p.reportCount ?? p.report_count ?? null) as number | null,
  }));
}

// Same helper names the page called on the old shared client, so the surface
// reads unchanged — only the wire underneath moved to the invoke route.
export const api = {
  // ── Conversations ────────────────────────────────────────────────────────
  outreachWaThreads: (opts: { q?: string; limit?: number; status?: OutreachStatus | 'all' | 'working' } = {}) =>
    invoke<{ threads: OutreachThread[]; total: number; counts: OutreachCounts }>('list_prospect_threads', {
      q: opts.q || '', limit: opts.limit || null, status: opts.status || 'active',
    }),
  outreachWaThread: (opts: { chat_id?: string; lead_id?: string; limit?: number }) =>
    invoke<OutreachThreadDetail>('read_prospect_thread', {
      chat_id: opts.chat_id || null, lead_id: opts.lead_id || null, limit: opts.limit || null,
    }),
  outreachMarkDead: (lead_id: string, dead = true, reason?: string) =>
    invoke<{ lead_id: string; dead: boolean; error?: string }>('mark_thread_dead', { lead_id, dead, reason: reason || null }),
  outreachDraft: (body: { chat_id?: string; lead_id?: string; force_llm?: boolean }) =>
    invoke<OutreachDraft>('draft_prospect_reply', {
      chat_id: body.chat_id || null, lead_id: body.lead_id || null, force_llm: !!body.force_llm,
    }).then((r) =>
      // A bare {error} (no chat resolvable) reads as "nothing to suggest",
      // exactly like the old route's failure envelope did.
      r && !r.source && r.error ? { draft: null, source: 'none' as const, reason: r.error } : r,
    ),
  waSend: (chatId: string, text: string) =>
    invoke<{ messageId?: string; timestamp?: number; chatId?: string; outbox_id?: string; error?: string }>(
      'send_prospect_message', { chatId, text },
    ),

  // ── the prospect card's org chart (a plain read, never a fetch) ──────────
  gtmLeadDetail: (id: string) =>
    invoke<{ lead: Record<string, unknown>; org_people: unknown; angles: unknown; error?: string }>('read_lead', { id })
      .then((r) => {
        if (r.error) throw new Error(r.error);
        // `sends` (the old route's fourth field) has no pack tool and nothing
        // on this page reads it — answered empty to keep the shape.
        return { lead: r.lead, org: orgRowsFromToolShape(r.org_people), angles: r.angles, sends: [] as unknown[] };
      }),

  // ── manual scheduled sends (the composer's schedule-first path) ──────────
  gtmSchedule: (id: string, bubbles: string[], send_at: number) =>
    invoke<{ ok?: boolean; id?: string; schedule_id?: string; send_at?: number; error?: string }>(
      'schedule_send', { id, bubbles, send_at },
    ),
  gtmSchedules: (lead?: string) =>
    invoke<{ schedules?: ScheduledSendRow[]; defaults?: ScheduleDefaultsRow }>(
      'list_scheduled_sends', { lead_id: lead || undefined },
    ),
  gtmCancelSchedule: (id: string) =>
    invoke<{ ok?: boolean; error?: string }>('cancel_scheduled_send', { schedule_id: id }),

  // ── Cohorts ──────────────────────────────────────────────────────────────
  outreachCohortMembers: (status?: string, cohort_id?: string) =>
    invoke<{ members: OutreachCohortMember[]; cohorts: OutreachCohort[]; counts: Record<string, number>; live: boolean }>(
      'list_cohort_members', { status: status || null, cohort_id: cohort_id || null },
    ),
  outreachCohortUpdate: (cohort_id: string, patch: Partial<Pick<OutreachCohort,
    'name' | 'status' | 'timezone' | 'start_hour' | 'end_hour' | 'send_days' | 'send_windows' | 'languages'>>) =>
    invoke<{ ok?: boolean; error?: string }>('update_cohort', { ...patch, cohort_id }),
  outreachDraftStep: (cohort_id: string, body: { step_index: number; language: string; instruction?: string }) =>
    invoke<{ draft?: string; based_on?: number; error?: string }>('draft_step_copy', {
      cohort_id, step_index: body.step_index || 0, language: body.language || 'en', instruction: body.instruction || '',
    }),
  outreachSequence: (cohort_id: string) =>
    invoke<OutreachSequenceInfo>('read_sequence', { cohort_id }),
  outreachSaveSequence: (cohort_id: string, sequence: OutreachSequence, scope: SequenceScope = 'new_only') =>
    invoke<{ ok?: boolean; error?: string; steps?: number; languages?: string[]; unknown_variables?: string[];
        scope?: SequenceScope; edits_replaced?: number; edits_kept?: number; approvals_withdrawn?: number }>(
      'save_sequence', { cohort_id, sequence, scope },
    ),
  outreachApprove: (lead_ids: string[], approve = true) =>
    invoke<OutreachApproveResult>('approve_message', { lead_ids, approve }),
  outreachEditMessage: (lead_id: string, text: string, clear = false) =>
    invoke<{ lead_id?: string; step?: number; text?: string; cleared?: boolean; error?: string }>(
      'override_message', { lead_id, text: text || '', clear: !!clear },
    ),
  outreachGoLive: (lead_ids: string[]) =>
    invoke<OutreachGoLiveResult>('launch_members', { lead_ids }),
  outreachReschedule: (lead_id: string, send_at: number) =>
    invoke<{ lead_id?: string; next_send_at?: number; went_live?: boolean; outside_window?: boolean;
        label?: string; zone?: string; error?: string }>('reschedule_member', { lead_id, send_at }),
  // The one action string, fanned out to the three verbs the way the old
  // /api/outreach/cohort/control route did.
  outreachCohortControl: (lead_id: string, action: 'pause' | 'resume' | 'stop' | 'unschedule') => {
    switch (action) {
      case 'pause':      return invoke<{ lead_id: string; status?: string; error?: string }>('pause_member', { lead_id, paused: true });
      case 'resume':     return invoke<{ lead_id: string; status?: string; error?: string }>('pause_member', { lead_id, paused: false });
      case 'stop':       return invoke<{ lead_id: string; status?: string; error?: string }>('stop_member', { lead_id });
      case 'unschedule': return invoke<{ lead_id: string; status?: string; error?: string }>('unschedule_member', { lead_id });
    }
  },
  outreachCohortRemove: (lead_id: string) =>
    invoke<{ removed: boolean; error?: string }>('remove_member', { lead_id }),
  outreachCohortTick: (opts: { dry_run?: boolean; force?: boolean } = {}) =>
    invoke<OutreachTickResult>('run_cohort_tick', {
      dry_run: opts.dry_run === undefined ? null : !!opts.dry_run, force: !!opts.force,
    }),
};
