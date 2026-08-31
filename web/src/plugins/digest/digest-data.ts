// Digest plugin — the Digest surface's data layer.
//
// The host REST routes this page used to call in cmd (/api/digest/*,
// /api/wa/chats, /api/contacts, /api/osint/targets) are not part of this
// host: a plugin surface drives its OWN plugin's tools through the scoped
// invoke route, so the page, the cron and Nyo all go through the exact same
// verbs and can never diverge. The types travel with the module (they lived
// in web/src/lib/api.ts in cmd).
//
// Dropped from cmd on purpose (see the pack report): the outreach KPI strip
// (api.digestKpi / digestKpiAttempts — the KPI is outreach-module data with
// host-table writes a plugin may not perform) and the PDL phone-enrich
// button (cmd-only gateway).

export type DigestKind = 'wa_message' | 'wa_group' | 'osint_mention' | 'osint_insight' | 'content_opportunity' | 'email' | 'note' | 'opportunity' | 'li_signal' | 'attention';

export type DigestItem = {
  id: string;
  kind: DigestKind;
  meta_json?: string | null;
  ref_kind: string | null;
  ref_id: string | null;
  title: string;
  summary: string | null;
  source_label: string | null;
  source_url: string | null;
  urgency: 1 | 2 | 3;           // 1 = high, 3 = low
  actionable: number;           // 0 | 1
  suggested_action: string | null;
  starred: number;              // 0 | 1
  read_at: number | null;
  created_at: number;
  meta: unknown;
};

export type DigestStats = {
  total: number;
  unread: number;
  high: number;
  action_count: number;
  starred: number;
  last_generated_at: number | null;
};

export type DigestContextParticipant = {
  id: string;
  full_name: string | null;
  email: string | null;
  linkedin_url: string | null;
};

export type DigestContext = {
  item: DigestItem;
  message: {
    id: string;
    chat_id: string;
    from_me: number;
    sender_id: string | null;
    sender_name: string | null;
    body: string | null;
    timestamp: number;
  } | null;
  chat: { id: string; name: string | null; is_group: number } | null;
  thread: Array<{
    id: string;
    from_me: number;
    sender_id: string | null;
    sender_name: string | null;
    body: string | null;
    timestamp: number;
  }>;
  mention: Record<string, unknown> | null;
  participants: Record<string, DigestContextParticipant>;
};

export type DigestActionType = 'reply_wa' | 'discuss' | 'dismiss' | 'add_to_wishlist' | 'draft_blog' | 'draft_social' | 'draft_take';
export type DigestRecipientMode = 'group' | 'private' | 'reply_to_ask';
export type DigestRecipient = {
  kind: 'wa_chat';
  mode: DigestRecipientMode;
  id: string;
  name: string;
  label: string;
  quotedMessageId?: string;
  source_digest_id?: string;
  source_ask_summary?: string;
  match_reason?: string;
};
export type DigestAction = {
  type: DigestActionType;
  label: string;
  description: string;
  draft?: string;
  recipient?: DigestRecipient;
  recipients?: DigestRecipient[];
  recommended_mode?: DigestRecipientMode;
  recommended_reason?: string | null;
  recommended_target_name?: string | null;
  metadata?: {
    full_name?: string | null;
    phone?: string | null;
    sender_id?: string | null;
    chat_name?: string | null;
    linkedin_url?: string | null;
    email?: string | null;
    [k: string]: unknown;
  };
};
export type DigestActionsResponse = {
  item: DigestItem | null;
  context?: DigestContext;
  actions: DigestAction[];
};

export type DigestChannelSource = 'attention' | 'li_signals' | 'whatsapp' | 'calendar' | 'osint' | 'osint_insights' | 'heartbeat' | 'email';
export type DigestChannel = {
  source: DigestChannelSource;
  label: string;
  enabled: number;          // 1 | 0
  cadence: 'manual' | 'daily' | 'hourly';
  notes: string | null;
  last_run_at: number | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  total_runs: number;
  total_added: number;
  created_at: number;
  updated_at: number;
};

export type Contact = {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  status?: string | null;
};

export type WaChat = {
  id: string;
  name: string | null;
  is_group: number;
  auto_listen: number;
  last_message_at: number | null;
};

export type WatchedTarget = {
  id: string;
  name: string;
  domain: string | null;
  notes: string | null;
  mentions_count?: number;
  last_mention_at?: number | null;
};

export type WaSlots = {
  days_ahead: number; morning: string; evening: string; timezone: string;
  tz_by_prefix?: Record<string, string>; hold?: boolean;
};

export type GenerateResult = {
  generated: number;
  onboarding_needed?: boolean;
  note?: string;
  pruned?: number;
  since_ms?: number;
  per_source?: Record<string, { count: number; error: string | null; skipped?: string }>;
};

// ── the invoke pipe ────────────────────────────────────────────────────────
async function invoke<T>(tool: string, input: unknown): Promise<T> {
  const r = await fetch(`/api/plugins/digest/invoke/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d.result as T;
}

// Same helper names the cmd page used (api.listDigest, api.digestStats, …) so
// the page reads unchanged — only the wire underneath moved to the invoke
// route. Tool results that carry a soft {error} pass through for the UI to
// render inline (matching cmd's 200-with-error contract on the send paths).
export const api = {
  listDigest: (opts: { unread?: boolean; starred?: boolean; limit?: number } = {}) =>
    invoke<{ items: DigestItem[] }>('list_digest', {
      unread_only: !!opts.unread, starred_only: !!opts.starred, limit: opts.limit ?? 200,
    }).then((r) => r.items),
  digestStats: () => invoke<DigestStats>('digest_stats', {}),
  generateDigest: (since_ms?: number) =>
    invoke<GenerateResult>('generate_digest', since_ms ? { since_ms } : {}),
  patchDigestItem: (id: string, patch: { read?: boolean; starred?: boolean; draft?: string }) => {
    if (typeof patch.draft === 'string') return invoke<{ item: DigestItem }>('save_digest_draft', { id, draft: patch.draft }).then((r) => r.item);
    if (patch.read !== undefined) return invoke<{ item: DigestItem }>('mark_digest_read', { id, read: patch.read }).then((r) => r.item);
    return invoke<{ item: DigestItem }>('star_digest_item', { id, starred: !!patch.starred }).then((r) => r.item);
  },
  listDigestChannels: () => invoke<{ channels: DigestChannel[] }>('list_digest_channels', {}).then((r) => r.channels),
  patchDigestChannel: (source: string, patch: { enabled?: number; cadence?: string; notes?: string }) =>
    invoke<{ channel: DigestChannel }>('toggle_digest_channel', {
      source,
      ...(patch.enabled !== undefined ? { enabled: !!patch.enabled } : {}),
      ...(patch.cadence ? { cadence: patch.cadence } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    }).then((r) => r.channel),
  digestContext: (id: string) => invoke<DigestContext>('digest_context', { id }),
  digestActions: (id: string) => invoke<DigestActionsResponse>('digest_actions', { id }),
  executeDigestAction: (id: string, action: Record<string, unknown>) =>
    invoke<{ ok?: boolean; error?: string; sent?: Record<string, unknown>; contact?: Contact & Record<string, unknown>; scheduled_for?: number | null }>(
      'execute_digest_action', { id, ...action }),
  digestWaSend: (id: string, body: { text?: string; send_at?: number }) =>
    invoke<{ ok?: boolean; error?: string; queue_id?: string; scheduled_for?: number | null; archived_signals?: number; slots?: WaSlots }>(
      'digest_wa_send', { digest_id: id, ...body }),
  digestWaManual: (id: string, text: string) =>
    invoke<{ ok?: boolean; error?: string; archived_signals?: number }>('digest_wa_manual', { digest_id: id, text }),
  digestWaUnschedule: (id: string) =>
    invoke<{ ok?: boolean; error?: string; cancelled?: Record<string, unknown> }>('digest_wa_unschedule', { digest_id: id }),
  digestWaSlots: () => invoke<WaSlots>('wa_send_slots', {}),
  digestWaPitches: () => invoke<{ pitches: { key: string; label: string; text: string }[] }>('wa_pitches', {}),
  digestSnooze: (id: string) =>
    invoke<{ ok?: boolean; error?: string; until?: number; days?: number }>('signal_snooze', { digest_id: id }),
  digestActed: (id: string) =>
    invoke<{ ok?: boolean; error?: string; engaged_count?: number }>('signal_acted', { digest_id: id }),
  digestPriorityFeedback: (id: string, comment: string) =>
    invoke<{ ok?: boolean; error?: string; rules?: number; rescored?: { ok?: boolean; score?: number; reason?: string } }>(
      'signal_feedback', { digest_id: id, comment }),
  listContacts: (opts: { search: string; limit?: number }) =>
    invoke<{ contacts: Contact[] }>('search_digest_contacts', opts).then((r) => r.contacts),
  listWaChats: () => invoke<{ chats: WaChat[] }>('list_watched_chats', {}).then((r) => r.chats),
  watchWaChat: (chat_id: string, listening: boolean) =>
    invoke<Record<string, unknown>>('watch_wa_chat', { chat_id, listening }),
  listWatchedTargets: () => invoke<{ targets: WatchedTarget[]; note?: string }>('list_watched_targets', {}),
};
