// Digest plugin: the morning brief. Every function that needs the outside
// world takes `api` as its FIRST argument (api.db / api.gateway /
// api.knowledge / api.saveKnowledge / api.log / api.discoverGateways). This
// file imports NOTHING.
//
// Two sources feed the brief, both probed live on every run:
//   search   - headlines for the operator's topics, through any installed
//              gateway that advertises the 'search' capability
//   calendar - the host calendar mirror's 7-day look-ahead
// Both materialize "cards" into plugin_digest_items. The page reads that
// table; the operator marks read / stars / snoozes / keeps a draft note.
//
// Tables written (plugin-owned): plugin_digest_items,
//   plugin_digest_signal_snoozes (read here; written by signal-priority.mjs)
// Host tables (SELECT-only, declared in requires.host_reads):
//   calendar_events, events
// Gateways: setup(read) for the fresh-install check. No LLM here: the
//   scorer (signal-priority.mjs) and the dismissal learner
//   (digest-relevance.mjs) are the pack's two reasoning passes.
// Knowledge (own docs, seeded on first read): plugin-digest-policy,
//   plugin-digest-search-topics.
//
// Cross-lib seam (lib files may not import each other): the snooze action in
// executeDigestAction rides ./signal-priority.mjs; the calling tool imports
// that lib and passes { snoozeItem } as the trailing `deps` argument. The
// snooze key builder below is duplicated there on purpose.

const now = () => Date.now();
const uid = () => crypto.randomUUID();
function safeJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return s; }
}

// ─── CRUD ───────────────────────────────────────────────────
export async function listDigestItems(api, { unread_only = false, starred_only = false, limit = 200 } = {}) {
  const where = [];
  if (unread_only)  where.push('read_at IS NULL');
  if (starred_only) where.push('starred = 1');
  const sql = `
    SELECT * FROM plugin_digest_items
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY urgency ASC, created_at DESC
    LIMIT ?
  `;
  const r = await api.db.prepare(sql).bind(limit).all();
  return (r.results || []).map((x) => ({ ...x, meta: safeJSON(x.meta_json) }));
}

export async function readDigestItem(api, id) {
  const r = await api.db.prepare('SELECT * FROM plugin_digest_items WHERE id = ?').bind(id).first();
  return r ? { ...r, meta: safeJSON(r.meta_json) } : null;
}

export async function patchDigestItem(api, id, patch) {
  const existing = await readDigestItem(api, id);
  if (!existing) throw new Error(`digest item ${id} not found`);
  const fields = [];
  const args   = [];
  if (patch.read !== undefined) {
    fields.push('read_at = ?');
    args.push(patch.read ? now() : null);
  }
  if (patch.starred !== undefined) {
    fields.push('starred = ?');
    args.push(patch.starred ? 1 : 0);
  }
  // Draft note auto-save: the card's editable note lives in meta_json.
  if (typeof patch.draft === 'string') {
    const meta = existing.meta && typeof existing.meta === 'object' ? existing.meta : {};
    meta.draft = patch.draft.slice(0, 2000);
    meta.draft_edited_at = now();
    fields.push('meta_json = ?');
    args.push(JSON.stringify(meta));
  }
  if (fields.length === 0) return existing;
  args.push(id);
  await api.db.prepare(`UPDATE plugin_digest_items SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run();
  return readDigestItem(api, id);
}

// The item plus its source row where one exists: a calendar card carries the
// calendar_events row it was derived from (declared host read); a news card
// is self-contained (the headline, the link, the topic it matched).
export async function getDigestItemContext(api, id) {
  const item = await readDigestItem(api, id);
  if (!item) return null;
  const out = { item, event: null };
  if (item.ref_kind === 'calendar_events' && item.ref_id) {
    try {
      const e = await api.db.prepare(
        `SELECT id, kind, title, description, starts_at, ends_at, all_day, status, location, link_url, platform
           FROM calendar_events WHERE id = ?`,
      ).bind(item.ref_id).first();
      if (e) out.event = e;
    } catch { /* calendar table absent on this install */ }
  }
  return out;
}

export async function insertDigestItem(api, item, { refresh = false } = {}) {
  const id = item.id || ('dig_' + uid().slice(0, 12));
  const cols = `(id, kind, ref_kind, ref_id, title, summary, source_label, source_url,
       urgency, actionable, suggested_action, starred, read_at, created_at, meta_json)`;
  const vals = `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`;
  // Two modes on an id collision:
  //  - default: INSERT OR IGNORE. A re-run of the same id is a silent no-op,
  //    so a read or dismissed card never resurrects and created_at stays put.
  //  - refresh: upsert the VOLATILE fields (title, summary, urgency, ...)
  //    while preserving read_at / starred / created_at. pullCalendar uses
  //    this so an approaching meeting's urgency and "when" text track the
  //    clock instead of freezing at first insert.
  const sql = refresh
    ? `INSERT INTO plugin_digest_items ${cols} ${vals}
       ON CONFLICT(id) DO UPDATE SET
         title            = excluded.title,
         summary          = excluded.summary,
         source_label     = excluded.source_label,
         suggested_action = excluded.suggested_action,
         urgency          = excluded.urgency,
         actionable       = excluded.actionable`
    : `INSERT OR IGNORE INTO plugin_digest_items ${cols} ${vals}`;
  await api.db.prepare(sql).bind(
    id,
    item.kind,
    item.ref_kind || null,
    item.ref_id   || null,
    item.title,
    item.summary  || null,
    item.source_label || null,
    item.source_url   || null,
    item.urgency != null ? item.urgency : 2,
    item.actionable ? 1 : 0,
    item.suggested_action || null,
    now(),
    item.meta ? JSON.stringify(item.meta) : null,
  ).run();
  return readDigestItem(api, id);
}

export async function clearReadDigestItems(api) {
  const r = await api.db.prepare('DELETE FROM plugin_digest_items WHERE read_at IS NOT NULL').run();
  const cleared = r.meta?.changes ?? 0;
  if (cleared > 0) await api.log('digest_cleared', { cleared });
  return { cleared };
}

// ─── snooze keys (shared with signal-priority.mjs, duplicated by contract) ──
// What "snooze this" mutes for a while: a news card mutes its outlet
// (source_label), a card derived from a host row mutes that row, anything
// else mutes just itself. The pullers consult the active keys so a snoozed
// outlet or event stays out of the brief until the snooze expires.
export function digestSnoozeKey(item) {
  if (!item) return null;
  const label = String(item.source_label || '').trim().toLowerCase();
  if (item.kind === 'news' && label) return 'source:' + label;
  if (item.ref_kind && item.ref_id) return `ref:${item.ref_kind}:${item.ref_id}`;
  return 'item:' + item.id;
}

async function activeSnoozeKeys(api) {
  try {
    const r = await api.db.prepare('SELECT key FROM plugin_digest_signal_snoozes WHERE until > ?').bind(now()).all();
    return new Set((r.results || []).map((x) => String(x.key)));
  } catch { return new Set(); }
}

// Snoozing one card also archives its unread siblings that share the key
// (the other headlines from the same outlet, say). deps-wired into
// signal-priority.mjs's snoozeItem by the calling tool.
export async function archiveItemsByKey(api, key, { except_id = null } = {}) {
  if (!key) return 0;
  const rows = (await api.db.prepare(
    'SELECT id, kind, ref_kind, ref_id, source_label FROM plugin_digest_items WHERE read_at IS NULL',
  ).all()).results || [];
  let archived = 0;
  for (const row of rows) {
    if (except_id && row.id === except_id) continue;
    if (digestSnoozeKey(row) !== key) continue;
    await api.db.prepare('UPDATE plugin_digest_items SET read_at = ? WHERE id = ?').bind(now(), row.id).run();
    archived++;
  }
  if (archived) await api.log('digest_items_archived_by_key', { key, archived });
  return archived;
}

// ─── per-item actions ───────────────────────────────────────
// The actions an operator can take on a card. No drafting, no LLM: every
// action is a one-step verb the page and Nyo both run through
// executeDigestAction.
//   { type, label, description, url? }
export async function draftDigestActions(api, id) {
  const ctx = await getDigestItemContext(api, id);
  if (!ctx) return { item: null, actions: [] };
  const item = ctx.item;
  const actions = [];
  if (item.source_url) {
    actions.push({ type: 'open_link', label: 'Open link', description: item.source_url, url: item.source_url });
  }
  actions.push({
    type: 'mark_read',
    label: item.read_at ? 'Mark unread' : 'Mark read',
    description: item.read_at ? 'Put the card back in the brief.' : 'Dismiss from the brief. The item stays in the activity log.',
  });
  actions.push({
    type: 'star',
    label: item.starred ? 'Unstar' : 'Star',
    description: 'Pinned cards stay visible across day rolls.',
  });
  actions.push({
    type: 'save_draft',
    label: 'Save draft note',
    description: 'Keep a note on the card (auto-saves from the page).',
  });
  actions.push({
    type: 'snooze',
    label: 'Snooze',
    description: item.kind === 'news'
      ? `Keep ${item.source_label || 'this outlet'} out of the brief for a while.`
      : 'Keep this out of the brief for a while.',
  });
  return { item, context: ctx, actions };
}

export async function executeDigestAction(api, id, action, deps = {}) {
  if (!action?.type) throw new Error('action.type required');
  const item = await readDigestItem(api, id);
  if (!item) throw new Error('digest item not found');

  if (action.type === 'open_link') {
    if (!item.source_url) throw new Error('this card has no link');
    await api.log('digest_action', { id, type: 'open_link', url: item.source_url });
    return { ok: true, url: item.source_url };
  }
  if (action.type === 'mark_read') {
    const read = action.read !== undefined ? !!action.read : true;
    const next = await patchDigestItem(api, id, { read });
    await api.log('digest_action', { id, type: 'mark_read', read });
    return { ok: true, item: next };
  }
  if (action.type === 'star') {
    const starred = action.starred !== undefined ? !!action.starred : !item.starred;
    const next = await patchDigestItem(api, id, { starred });
    await api.log('digest_action', { id, type: 'star', starred });
    return { ok: true, item: next };
  }
  if (action.type === 'save_draft') {
    if (typeof action.draft !== 'string') throw new Error('save_draft needs draft text');
    const next = await patchDigestItem(api, id, { draft: action.draft });
    await api.log('digest_action', { id, type: 'save_draft', chars: action.draft.length });
    return { ok: true, item: next };
  }
  if (action.type === 'snooze') {
    if (typeof deps.snoozeItem !== 'function') {
      throw new Error('snooze needs deps.snoozeItem (from ./signal-priority.mjs): wire it in the calling tool');
    }
    const r = await deps.snoozeItem(api, id, { archiveItemsByKey });
    await api.log('digest_action', { id, type: 'snooze', until: r?.until || null });
    return { ok: true, ...r };
  }
  throw new Error(`unknown action type: ${action.type}`);
}

// ─── digest policy (knowledge-backed) ────────────────────────
// The tunable thresholds live in the plugin-digest-policy knowledge doc as
// JSON: the operator edits the doc, no deploy. A missing or broken doc falls
// back to these defaults.
const DIGEST_POLICY_DEFAULTS = Object.freeze({
  sources_off: [],             // sources to skip even when present, e.g. ["calendar"]
  search_topics_cap: 5,        // most topics looked up per run
  search_per_topic_limit: 5,   // most headlines kept per topic per provider
  search_urgency: 2,           // where search items land in the brief
  calendar_lookahead_days: 7,  // how far ahead calendar cards reach
  stale_after_days: 7,         // soft-archive unread, unstarred, non-urgent items
  delete_after_days: 14,       // hard-delete read items past this horizon
});
function polNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
async function loadDigestPolicy(api) {
  try {
    const row = await api.knowledge('plugin-digest-policy');
    if (!row?.body) {
      await api.saveKnowledge('plugin-digest-policy', {
        title: 'Digest policy: scan windows + caps',
        body: JSON.stringify(DIGEST_POLICY_DEFAULTS, null, 2),
      }).catch(() => {});
      return { ...DIGEST_POLICY_DEFAULTS };
    }
    const m = String(row.body).match(/\{[\s\S]*\}/);
    const src = m ? JSON.parse(m[0]) : {};
    const out = {};
    for (const [k, dflt] of Object.entries(DIGEST_POLICY_DEFAULTS)) {
      out[k] = Array.isArray(dflt)
        ? (Array.isArray(src[k]) ? src[k].map(String) : [...dflt])
        : polNum(src[k], dflt);
    }
    return out;
  } catch {
    return { ...DIGEST_POLICY_DEFAULTS };
  }
}

// ─── search: operator topics x every installed search provider ────────────
// The provider is DISCOVERED, never named: any plugin whose gateway advertises
// capability 'search' is queried for each topic in the
// plugin-digest-search-topics doc. No providers or no topics = a soft note,
// not an error: the source simply has nothing to say yet.
const SEARCH_TOPICS_DEFAULT = `# Digest search topics

One topic per line. The digest's search source looks each of these up every
run and files fresh headlines into the brief. Lines starting with # are
ignored. Keep it to a handful: the brief should stay a brief.

AI agents
`;

async function pullSearch(api) {
  const providers = await api.discoverGateways('search');
  if (!providers.length) return { ids: [], error: 'no search provider installed: add one (e.g. the News Search plugin)' };
  const policy = await loadDigestPolicy(api);

  let doc = null;
  try { doc = await api.knowledge('plugin-digest-search-topics'); } catch { doc = null; }
  if (!doc) {
    try {
      await api.saveKnowledge('plugin-digest-search-topics', { title: 'Digest search topics', body: SEARCH_TOPICS_DEFAULT });
      doc = { body: SEARCH_TOPICS_DEFAULT };
    } catch { doc = { body: SEARCH_TOPICS_DEFAULT }; }
  }
  const topics = String(doc.body || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .slice(0, policy.search_topics_cap);
  if (!topics.length) return { ids: [], error: 'no topics listed: edit the "Digest search topics" doc in Knowledge' };

  const snoozed = await activeSnoozeKeys(api);
  const ids = [];
  const seen = new Set();
  let lastErr = null;
  let muted = 0;
  for (const topic of topics) {
    for (const p of providers) {
      let r = null;
      try { r = await p.call({ query: topic, limit: policy.search_per_topic_limit }); }
      catch (e) { lastErr = String(e?.message || e); r = null; }
      if (!r?.ok) { if (r?.error) lastErr = String(r.error); continue; }
      for (const hit of r.results || []) {
        if (!hit?.url || seen.has(hit.url)) continue;
        seen.add(hit.url);
        const label = hit.source || p.label || null;
        // A snoozed outlet stays out until the snooze expires.
        if (label && snoozed.has('source:' + String(label).trim().toLowerCase())) { muted++; continue; }
        // One stable id per URL: a headline that was read or dismissed stays
        // read on every later run (INSERT OR IGNORE semantics).
        let h = 0;
        for (let i = 0; i < hit.url.length; i++) h = ((h << 5) - h + hit.url.charCodeAt(i)) | 0;
        const id = 'srch_' + (h >>> 0).toString(36);
        const inserted = await insertDigestItem(api, {
          id, kind: 'news', ref_kind: 'search', ref_id: topic,
          title: hit.title,
          summary: [hit.source, hit.published_at, `topic: ${topic}`].filter(Boolean).join(' · '),
          source_label: label, source_url: hit.url,
          urgency: policy.search_urgency, actionable: 0, suggested_action: null,
        });
        if (inserted) ids.push(id);
      }
    }
  }
  // Nothing landed AND a provider was failing: that is a source problem, not
  // a quiet news day. Surface it in the generate result.
  if (!ids.length && lastErr) return { ids, error: `search provider failing: ${lastErr.slice(0, 160)}` };
  return { ids, error: null, meta: { topics: topics.length, providers: providers.length, muted } };
}

// ─── calendar: the host mirror's look-ahead ──────────────────────────────
async function pullCalendar(api, nowMs) {
  // Look-AHEAD window: events in the next calendar_lookahead_days.
  // calendar_events is a declared host_read (SELECT only); the derived digest
  // rows land in the plugin table.
  const policy = await loadDigestPolicy(api);
  const snoozed = await activeSnoozeKeys(api);
  const inserted = [];
  const horizon = nowMs + policy.calendar_lookahead_days * 24 * 60 * 60 * 1000;
  // Window on END, not start: include events that start within the window
  // AND have not finished yet (assume a 1h duration when ends_at is null), so
  // an ongoing meeting stays on the brief instead of vanishing the moment it
  // begins.
  const r = await api.db.prepare(`
    SELECT id, kind, title, description, starts_at, ends_at, all_day, status,
           location, link_url, platform
      FROM calendar_events
     WHERE starts_at <= ?
       AND COALESCE(ends_at, starts_at + 3600000) >= ?
       AND status != 'cancelled'
     ORDER BY starts_at ASC
     LIMIT 50
  `).bind(horizon, nowMs).all();
  for (const e of (r.results || [])) {
    if (snoozed.has(`ref:calendar_events:${e.id}`)) continue;
    const startsIn = e.starts_at - nowMs;
    const minutes  = Math.round(startsIn / 60000);
    let when;
    if (Math.abs(minutes) < 60) when = minutes <= 0 ? 'now' : `in ${minutes}m`;
    else if (Math.abs(minutes) < 1440) when = `in ${Math.round(minutes / 60)}h`;
    else when = `${new Date(e.starts_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;

    // Urgency: soon = high; today = medium; later = low.
    const urgency = minutes < 60 ? 1 : minutes < 12 * 60 ? 2 : 3;
    const inserted_ = await insertDigestItem(api, {
      id: 'cal_' + e.id,
      kind: 'opportunity', // reads as "upcoming" under the amber chip
      ref_kind: 'calendar_events',
      ref_id:   e.id,
      title:    `${e.title} · ${when}`,
      summary:  e.description || (e.location ? `Location: ${e.location}` : null),
      source_label: `Calendar · ${e.kind || 'event'}`,
      source_url:   e.link_url,
      urgency,
      actionable: 1,
      suggested_action: e.kind === 'meeting' ? 'Open invite' : 'Confirm / prep',
    }, { refresh: true }); // re-run updates urgency + "when" as the meeting nears
    if (inserted_) inserted.push(inserted_.id);
  }
  return inserted;
}

// ─── prune ───────────────────────────────────────────────────────────────
// Sweep stale cards off the brief. Anything older than stale_after_days that
// is not starred AND not urgency=1 gets soft-archived (read_at set): the row
// stays for audit, it just stops topping the brief. Well past that,
// delete_after_days hard-deletes read, unstarred, non-urgent rows so the
// table never grows without bound. The pullers dedupe on stable ids, so a
// deleted card that is still current simply comes back fresh.
export async function pruneStaleDigestItems(api, { staleAfterMs = null } = {}) {
  const policy = await loadDigestPolicy(api);
  const cutoff = now() - (staleAfterMs ?? policy.stale_after_days * 24 * 60 * 60 * 1000);
  const r = await api.db.prepare(
    `UPDATE plugin_digest_items
        SET read_at = ?
      WHERE read_at IS NULL
        AND starred = 0
        AND urgency != 1
        AND created_at < ?`,
  ).bind(now(), cutoff).run();
  const pruned = r?.meta?.changes ?? r?.changes ?? 0;

  const delCutoff = now() - policy.delete_after_days * 24 * 60 * 60 * 1000;
  const d = await api.db.prepare(
    `DELETE FROM plugin_digest_items
      WHERE read_at IS NOT NULL
        AND starred = 0
        AND urgency != 1
        AND created_at < ?`,
  ).bind(delCutoff).run();
  const deleted = d?.meta?.changes ?? d?.changes ?? 0;

  if (pruned > 0 || deleted > 0) {
    await api.log('digest_pruned_stale', { pruned, deleted, cutoff_ms: cutoff, delete_cutoff_ms: delCutoff, stale_after_ms: staleAfterMs });
  }
  return { pruned, deleted, cutoff };
}

// ─── generate ────────────────────────────────────────────────────────────
// A digest has nothing to say before the install is onboarded: no search
// provider, no calendar rows, no prior items, no setup receipt. Instead of
// day-zero noise the run points the operator at Nyo to onboard.
async function isFreshUnonboarded(api) {
  const anyItem = await api.db.prepare('SELECT id FROM plugin_digest_items LIMIT 1').first().catch(() => null);
  if (anyItem) return false;
  const receipt = await api.gateway('setup', 'read', { module: 'digest' }).catch(() => null);
  if (receipt) return false;
  let providers = 0;
  try { providers = (await api.discoverGateways('search')).length; } catch { providers = 0; }
  if (providers > 0) return false;
  const anyEvent = await api.db.prepare('SELECT id FROM calendar_events LIMIT 1').first().catch(() => null);
  return !anyEvent;
}

export async function generateDigest(api, { since_ms = 24 * 60 * 60 * 1000 } = {}) {
  const nowMs = now();
  const inserted = [];
  const perSource = {};

  if (await isFreshUnonboarded(api)) {
    return {
      ok: true,
      onboarding_needed: true,
      note: 'Nothing to digest yet: this install has no sources connected. Ask Nyo to onboard: install a search provider and set your topics, or connect the calendar, and the digest starts filling on its own.',
      inserted: 0, per_source: {}, archived: 0,
    };
  }
  // Step 0: archive anything that has gone stale since the last run. The
  // count flows back so the page can show "N archived" beside the +N adds.
  const prune = await pruneStaleDigestItems(api);

  // A source runs only while its backing exists on THIS install, probed live
  // every run: a search provider installed means search runs; a readable
  // calendar mirror means calendar runs. The knobs that matter (topics,
  // caps, sources_off) live in Knowledge.
  const probeTable = async (table) => {
    try { await api.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).all(); return true; }
    catch { return false; }
  };
  const available = {
    search: async () => { try { return (await api.discoverGateways('search')).length > 0; } catch { return false; } },
    calendar: () => probeTable('calendar_events'),
  };
  const policy = await loadDigestPolicy(api);
  const off = new Set(Array.isArray(policy.sources_off) ? policy.sources_off.map(String) : []);
  async function maybeRun(source, runFn) {
    if (off.has(source)) { perSource[source] = { count: 0, skipped: 'off in policy' }; return; }
    let on = false;
    try { on = await available[source](); } catch { on = false; }
    if (!on) {
      perSource[source] = { count: 0, skipped: 'not on this install' };
      return;
    }
    let added = 0, softErr = null, hardErr = null;
    try {
      // A puller returns either `string[]` (just ids, success) or
      // `{ ids, error }` (success or partial plus a soft note). A soft error
      // is NOT a failure: data landed, or there was simply nothing to digest.
      // Only a thrown error is a real failure.
      const r = await runFn();
      const ids   = Array.isArray(r) ? r : (r?.ids || []);
      softErr     = Array.isArray(r) ? null : (r?.error || null);
      inserted.push(...ids);
      added = ids.length;
    } catch (e) {
      hardErr = String(e?.message || e);
    }
    const error = hardErr || softErr;
    perSource[source] = { count: added, error };
  }

  await maybeRun('search',   () => pullSearch(api));
  await maybeRun('calendar', () => pullCalendar(api, nowMs));

  await api.log('digest_generated', { count: inserted.length, per_source: perSource, pruned: prune.pruned });
  return { generated: inserted.length, pruned: prune.pruned, since_ms, per_source: perSource };
}

export async function digestStats(api) {
  const r = await api.db.prepare(`
    SELECT
      COUNT(*)                                                AS total,
      SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END)        AS unread,
      SUM(CASE WHEN read_at IS NULL AND urgency = 1 THEN 1 ELSE 0 END) AS high,
      SUM(CASE WHEN read_at IS NULL AND actionable = 1 THEN 1 ELSE 0 END) AS action_count,
      SUM(CASE WHEN starred = 1 THEN 1 ELSE 0 END)            AS starred
    FROM plugin_digest_items
  `).first();
  // The most recent generate() run, read off the activity bus (events is a
  // declared host_read). api.log prefixes kinds with plugin_digest_, so the
  // generate event lands as 'plugin_digest_digest_generated'.
  const last = await api.db.prepare(
    `SELECT created_at FROM events WHERE kind = 'plugin_digest_digest_generated' ORDER BY created_at DESC LIMIT 1`
  ).first();
  return {
    ...(r || { total: 0, unread: 0, high: 0, action_count: 0, starred: 0 }),
    last_generated_at: last?.created_at || null,
  };
}
