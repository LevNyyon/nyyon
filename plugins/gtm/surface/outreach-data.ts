// GTM plugin — the Outreach surface's data layer.
//
// A plugin surface drives its OWN plugin's tools through the scoped invoke
// route, so the page, the cron and Nyo all write through the exact same verbs
// and can never diverge. The types travel with the module too.

// ── the prospect inbox ─────────────────────────────────────────────────────
// A conversation row. `uncaught` = they spoke last, so the ball is in our
// court; those pin to the top of the list.
export type OutreachStatus = 'active' | 'unanswered' | 'dead' | 'fresh' | 'scheduled';
export type OutreachCounts = Record<OutreachStatus, number>;
export type OutreachThread = {
  chat_id: string; lead_id: string;
  scheduled_text?: string | null; scheduled_at?: number | null;
  name: string | null; company: string | null; position: string | null;
  photo: string | null; icp_fit: string | null;
  last_text: string | null; last_from_me: boolean | null; last_at: number | null;
  uncaught: boolean; never_messaged: boolean; answered: boolean;
  msgs_in: number | null; msgs_out: number | null;
  status: OutreachStatus;
  dead_marked: boolean; dead_reason: string | null;
  dead_by: 'marked' | 'stale' | null;
};

// Everything the side panel shows about the person and their company. The
// company half is the fact sheet company_context stores on the lead.
export type OutreachProspect = {
  lead_id: string;
  name: string | null; company: string | null; position: string | null;
  photo: string | null; phone: string | null; email: string | null;
  linkedin: string | null; company_linkedin: string | null;
  company_staff_count: number | null;
  company_summary: string | null; company_industry: string | null;
  company_hq: string | null; company_site: string | null;
  country: string | null; region: string | null;
  icp_fit: string | null; icp_reasons: string[]; icp_gaps: string[];
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

// ── the queue ──────────────────────────────────────────────────────────────
// A message the operator approved and parked for a moment in the future. It
// sits here, cancellable, until the cron tick claims it and sends it.
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
      // A bare {error} (no chat resolvable) reads as "nothing to suggest".
      r && !r.source && r.error ? { draft: null, source: 'none' as const, reason: r.error } : r,
    ),
  waSend: (chatId: string, text: string) =>
    invoke<{ messageId?: string; timestamp?: number; chatId?: string; outbox_id?: string; error?: string }>(
      'send_prospect_message', { chatId, text },
    ),

  // ── the queue ────────────────────────────────────────────────────────────
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
};
