// Digest plugin: the Digest surface's data layer.
//
// A plugin surface drives its OWN plugin's tools through the scoped invoke
// route, so the page, the cron and Nyo all go through the exact same verbs
// and can never diverge. The types travel with the module.

export type DigestKind = 'news' | 'opportunity' | 'note';

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

// What a card carries in meta_json (parsed defensively on the client).
export type DigestMeta = {
  draft?: string | null;
  draft_edited_at?: number;
  priority?: number;
  priority_reason?: string;
  priority_at?: number;
};

export type DigestStats = {
  total: number;
  unread: number;
  high: number;
  action_count: number;
  starred: number;
  last_generated_at: number | null;
};

export type CalendarEventRow = {
  id: string;
  kind: string | null;
  title: string;
  description: string | null;
  starts_at: number;
  ends_at: number | null;
  all_day: number | null;
  status: string | null;
  location: string | null;
  link_url: string | null;
  platform: string | null;
};

export type DigestContext = {
  item: DigestItem;
  event: CalendarEventRow | null;
};

export type DigestActionType = 'open_link' | 'mark_read' | 'star' | 'save_draft' | 'snooze';
export type DigestAction = {
  type: DigestActionType;
  label: string;
  description: string;
  url?: string;
};
export type DigestActionsResponse = {
  item: DigestItem | null;
  context?: DigestContext;
  actions: DigestAction[];
};

export type GenerateResult = {
  generated: number;
  onboarding_needed?: boolean;
  note?: string;
  pruned?: number;
  since_ms?: number;
  per_source?: Record<string, { count: number; error: string | null; skipped?: string }>;
};

export function parseMeta(item: Pick<DigestItem, 'meta_json'>): DigestMeta {
  try { return (JSON.parse(item.meta_json || '{}') || {}) as DigestMeta; } catch { return {}; }
}

// The invoke pipe.
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

// Tool results that carry a soft {error} pass through for the UI to render
// inline.
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
  digestContext: (id: string) => invoke<DigestContext>('digest_context', { id }),
  digestActions: (id: string) => invoke<DigestActionsResponse>('digest_actions', { id }),
  executeDigestAction: (id: string, action: { type: DigestActionType; read?: boolean; starred?: boolean; draft?: string }) =>
    invoke<{ ok?: boolean; error?: string; url?: string; item?: DigestItem; until?: number; days?: number; archived?: number }>(
      'execute_digest_action', { id, ...action }),
  digestSnooze: (id: string) =>
    invoke<{ ok?: boolean; error?: string; until?: number; days?: number; archived?: number }>('signal_snooze', { digest_id: id }),
  digestPriorityFeedback: (id: string, comment: string) =>
    invoke<{ ok?: boolean; error?: string; rules?: number; rescored?: { ok?: boolean; score?: number; reason?: string } }>(
      'signal_feedback', { digest_id: id, comment }),
};

// ── sources + onboarding ─────────────────────────────────────
// Every data fetch must answer JSON. An HTML answer (the SPA fallback, a
// login page) is reported as what it is instead of a parse error.
async function jsonOrThrow(r: Response, what: string) {
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error(`${what}: server answered ${r.status} with ${text.trim().startsWith('<') ? 'HTML, not JSON (are you signed in? is the route deployed?)' : 'something that is not JSON'}`); }
}
export type DigestSources = {
  providers: { slug: string; label: string; connected: boolean; note: string | null }[];
  calendar: boolean; topics: string[]; configured: boolean; ready: boolean;
};
export type CatalogEntry = { name: string; title: string; version: string; description: string; capabilities: string[]; needs_key: boolean; file: string };
export const sources = {
  read: () => invoke<DigestSources>('digest_sources', {}),
  catalog: async (): Promise<CatalogEntry[]> => {
    const d = await jsonOrThrow(await fetch('/api/plugins/catalog'), 'catalog');
    return (d?.plugins || []).filter((p: CatalogEntry) => p.capabilities?.includes('search'));
  },
  installed: async (): Promise<Record<string, string>> => {
    const d = await jsonOrThrow(await fetch('/api/plugins'), 'plugins');
    const out: Record<string, string> = {};
    for (const p of (d?.plugins || d || [])) if (p?.name) out[p.name] = p.status;
    return out;
  },
  install: async (entry: CatalogEntry) => {
    const m = await jsonOrThrow(await fetch(`/api/plugins/catalog/${entry.name}`), `catalog entry ${entry.name}`);
    if (!m?.manifest) throw new Error(m?.error || `catalog entry ${entry.name} has no manifest`);
    const r = await fetch('/api/plugins/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: m.manifest }) });
    return jsonOrThrow(r, 'import') as Promise<{ ok: boolean; status?: string; errors?: string[]; error?: string }>;
  },
  buildPrompt: async (): Promise<string> => {
    try { const r = await fetch('/api/knowledge/plugin-digest-build-a-source'); const d = await r.json(); return String(d?.doc?.body || d?.body || ''); }
    catch { return ''; }
  },
};
