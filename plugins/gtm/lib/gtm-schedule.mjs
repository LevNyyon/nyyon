// GTM plugin · scheduled sends — ported from workers/api/src/lib/gtm-schedule.js.
// Schedule outreach bubbles for a future time, with the no-duplicate guarantee
// as the design center. Five independent layers, any one of which blocks a dup:
//
//   1. SCHEDULE-time: a DB partial-unique index rejects a second live schedule
//      of the same content for the same lead; identical content EVER sent to
//      this lead (plugin_gtm_sends history) is refused outright.
//   2. CLAIM-time: the runner claims a due row with an atomic conditional
//      UPDATE — concurrent runners cannot both win.
//   3. FAIL-CLOSED: once claimed, a row never re-arms itself. A crash between
//      claim and confirmation leaves it 'claimed' — surfaced to the operator,
//      never auto-retried. A missed send beats a duplicate, always.
//   4. SEND-time: delivery goes through the ONE send path (sendOutreach,
//      duplicated below from lib/gtm-outreach.mjs — contract: lib files may
//      not import each other), which carries its own recent-send refusal +
//      per-bubble plugin_gtm_sends log.
//   5. NO AUTO-RETRY: sends are tagged source='scheduled' toward the host
//      whatsapp gateway, which the wake-up auto-retry explicitly skips.
//
// Config (max horizon) is knowledge-backed: plugin-gtm-schedule doc, json fence.
//
// Contract v2.1 lib file: imports NOTHING; every exported function takes `api`
// first (contentHash stays pure — it never took env).

const now = () => Date.now();
const sid = () => `ss_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const gid = (p) => `${p}_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ── duplicated helpers (contract: no lib-to-lib imports) ─────────────────────

async function getLead(api, id) {
  return api.db.prepare('SELECT * FROM plugin_gtm_leads WHERE id = ?').bind(id).first();
}

// Normalize an input like "+972 50-000-0000", "972500000000", or already
// "972500000000@c.us" to a canonical wa-gateway chatId. Groups must come in
// already-formatted ("…@g.us"); `@lid` ids pass through unchanged.
function toChatId(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('chatId required');
  if (s.endsWith('@c.us') || s.endsWith('@g.us') || s.endsWith('@lid')) return s;
  const digits = s.replace(/\D/g, '');
  if (!digits) throw new Error(`could not parse chatId from ${input}`);
  return `${digits}@c.us`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// §9 pacing — the same tunable block sendOutreach reads in gtm-outreach.mjs
// (one doc, plugin-gtm-outreach, governs pacing for both send paths).
const PACING_DEFAULTS = { gap_min_ms: 4000, gap_jitter_ms: 5000, cap_ms: 12000 };
async function pacingConfig(api) {
  try {
    const doc = await api.knowledge('plugin-gtm-outreach');
    const m = String(doc?.body || '').match(/```json\s*([\s\S]*?)```/);
    const pacing = m ? JSON.parse(m[1])?.pacing : null;
    if (pacing && typeof pacing === 'object') return { ...PACING_DEFAULTS, ...pacing };
  } catch { /* malformed block — defaults win, a bad doc edit can't break sends */ }
  return PACING_DEFAULTS;
}
function bubbleGapMs(nextBubble, p = PACING_DEFAULTS) {
  const base = p.gap_min_ms + Math.random() * p.gap_jitter_ms;
  const scale = Math.min(1.5, 0.6 + String(nextBubble || '').length / 160);
  return Math.min(p.cap_ms, Math.round(base * scale));
}

// DUPLICATED from lib/gtm-outreach.mjs (behavior identical) — the runner's
// Layer 4 depends on this exact path: pacing, per-bubble logging, its own
// recent-send refusal. Keep the two copies in sync when the pacing spec moves.
async function sendOutreach(api, { lead_id, bubbles, force = false, source = 'operator', source_ref = null } = {}) {
  const lead = await getLead(api, lead_id);
  if (!lead) return { error: 'no lead' };
  const msgs = (bubbles || []).map((b) => String(b || '').trim()).filter(Boolean);
  if (!msgs.length) return { error: 'no bubbles to send' };
  if (msgs.length > 4) return { error: 'more than 4 bubbles — the playbook caps a first touch at 4' };
  if (!force) {
    const recent = await api.db.prepare("SELECT COUNT(*) AS n FROM plugin_gtm_sends WHERE lead_id = ? AND status = 'sent' AND created_at > ?")
      .bind(lead_id, now() - 10 * 60 * 1000).first();
    if ((recent?.n ?? 0) > 0) {
      return { error: 'bubbles were already sent to this lead in the last 10 minutes — the earlier send very likely went through (check plugin_gtm_sends / the Outbox). Pass force:true only if the operator confirms a re-send.' };
    }
  }
  const chatId = toChatId(lead.normalized_phone || lead.phone);
  await api.gateway('whatsapp', 'set_listening', { chat_id: chatId, listening: true }).catch(() => {});
  const pacing = await pacingConfig(api);
  const sent = [];
  for (let i = 0; i < msgs.length; i++) {
    try {
      // The gateway send throws on failure — the catch below is the single
      // failure path. source/source_ref ride in the input for the outbox.
      await api.gateway('whatsapp', 'send', { chatId, text: msgs[i], source, source_ref });
      await api.db.prepare('INSERT INTO plugin_gtm_sends (id, lead_id, chat_id, bubble, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(gid('gs'), lead_id, chatId, msgs[i], 'sent', null, now()).run();
      sent.push(i);
    } catch (e) {
      await api.db.prepare('INSERT INTO plugin_gtm_sends (id, lead_id, chat_id, bubble, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(gid('gs'), lead_id, chatId, msgs[i], 'failed', String(e.message || e).slice(0, 300), now()).run();
      return { sent, failed_at: i, error: String(e.message || e) };
    }
    if (i < msgs.length - 1) await sleep(bubbleGapMs(msgs[i + 1], pacing));
  }
  await api.log('outreach_sent', { id: lead_id, bubbles: msgs.length, chat_id: chatId });
  return { ok: true, sent: msgs.length, chat_id: chatId };
}

// ── content hash ─────────────────────────────────────────────────────────────

// Normalized content hash — same text modulo whitespace = same content.
export function contentHash(bubbles) {
  const norm = (bubbles || []).map((b) => String(b || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('');
  // djb2 — stable, dependency-free; collisions are backstopped by layer 4.
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}_${norm.length}`;
}

const CONFIG_SLUG = 'plugin-gtm-schedule';
// default_send_hour / default_days_ahead: what the Outreach card pre-fills in
// the schedule picker (operator-editable per send; edit the doc to change).
// timezone: the wall clock the picker's presets and displays use, regardless
// of where the operator's browser is (IANA name).
const CONFIG_DEFAULTS = { max_horizon_days: 30, default_send_hour: 12, default_days_ahead: 0, default_jitter_minutes: 9, timezone: 'America/New_York' };
const CONFIG_SEED = `GTM scheduled sends — rules the scheduler reads live.

A scheduled send fires on the worker's cron ticks (:00 / :06 / :45), so the
actual send lands at the FIRST tick at-or-after the scheduled time — up to
~40 minutes late, never early. Duplicates are structurally blocked: one live
schedule per lead+content, atomic claim, fail-closed on any ambiguity, no
auto-retry ever. A 'claimed' or 'failed' row is an operator decision, not a
retry queue.

default_send_hour + default_days_ahead set what the schedule picker offers
first (12 + 0 = the NEXT noon, rolling to tomorrow when noon has passed).
default_jitter_minutes adds random minutes so send times are never flat.
timezone is the wall clock those presets and every displayed schedule time
use (IANA name), wherever the operator's browser happens to be.

\`\`\`json
${JSON.stringify(CONFIG_DEFAULTS, null, 2)}
\`\`\`
`;

export async function scheduleConfig(api) { return config(api); }

async function config(api) {
  try {
    const doc = await api.knowledge(CONFIG_SLUG);
    if (!doc) {
      await api.saveKnowledge(CONFIG_SLUG, { title: 'GTM · scheduled sends', body: CONFIG_SEED }).catch(() => {});
      return { ...CONFIG_DEFAULTS };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    return { ...CONFIG_DEFAULTS, ...(m ? JSON.parse(m[1]) : {}) };
  } catch { return { ...CONFIG_DEFAULTS }; }
}

// ── schedule ────────────────────────────────────────────────────────────────
export async function scheduleSend(api, { lead_id, bubbles, send_at }) {
  const lead = await getLead(api, lead_id);
  if (!lead) return { error: 'no lead' };
  const msgs = (bubbles || []).map((b) => String(b || '').trim()).filter(Boolean);
  if (!msgs.length) return { error: 'no bubbles to schedule' };
  if (msgs.length > 4) return { error: 'more than 4 bubbles — the playbook caps a touch at 4' };
  const at = Number(send_at);
  if (!Number.isFinite(at) || at < now() - 60 * 1000) return { error: 'send_at must be a future time (ms epoch)' };
  const cfg = await config(api);
  if (at > now() + cfg.max_horizon_days * 86400 * 1000) return { error: `send_at is beyond the ${cfg.max_horizon_days}-day horizon` };

  let chatId;
  try { chatId = toChatId(lead.normalized_phone || lead.phone); }
  catch { return { error: 'lead has no usable phone' }; }

  await api.gateway('whatsapp', 'set_listening', { chat_id: chatId, listening: true }).catch(() => {});
  const hash = contentHash(msgs);
  // Layer 1b: identical content already DELIVERED to this lead, ever → refuse.
  // (Change the text if a deliberate re-send is wanted; there is no force here.)
  const prior = await api.db.prepare(
    `SELECT COUNT(*) AS n FROM plugin_gtm_sends WHERE lead_id = ? AND status = 'sent' AND bubble IN (${msgs.map(() => '?').join(',')})`,
  ).bind(lead_id, ...msgs).first();
  if ((prior?.n ?? 0) > 0) {
    return { error: 'refused: one or more of these exact bubbles was ALREADY SENT to this lead. Scheduling identical content again is blocked — edit the text if a deliberate repeat is intended.' };
  }

  const id = sid();
  try {
    await api.db.prepare(
      `INSERT INTO plugin_gtm_scheduled_sends (id, lead_id, chat_id, bubbles, content_hash, send_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
    ).bind(id, lead_id, chatId, JSON.stringify(msgs), hash, at, now(), now()).run();
  } catch (e) {
    // Layer 1a: the partial unique index — a live schedule of this content
    // already exists for this lead.
    if (/UNIQUE/i.test(String(e?.message || e))) {
      return { error: 'refused: an identical message is already scheduled for this lead (cancel it first if you want to reschedule).' };
    }
    throw e;
  }
  await api.log('send_scheduled', { id, lead_id, send_at: at, bubbles: msgs.length });
  return { ok: true, id, lead_id, send_at: at, bubbles: msgs, note: 'fires on the first cron tick at or after send_at (up to ~40 min late, never early, never twice)' };
}

export async function cancelScheduled(api, id) {
  // Atomic. A 'scheduled' row is cancelled before it fires; a terminal
  // 'failed'/'partial' row is dismissed (acknowledged) the same way. A
  // claimed row is in flight (or fail-closed) and cannot be un-fired.
  const r = await api.db.prepare(
    `UPDATE plugin_gtm_scheduled_sends SET status='cancelled', updated_at=? WHERE id=? AND status IN ('scheduled','failed','partial')`,
  ).bind(now(), id).run();
  const ok = (r.meta?.changes ?? 0) === 1;
  if (ok) await api.log('schedule_cancelled', { id });
  else {
    const row = await api.db.prepare('SELECT status FROM plugin_gtm_scheduled_sends WHERE id=?').bind(id).first();
    return { ok: false, error: row ? `cannot cancel: schedule is '${row.status}'` : 'schedule not found' };
  }
  return { ok: true, id };
}

// Cancelling a live schedule and dismissing a terminal failed/partial one are
// the same atomic UPDATE, but they are not the same thing to the operator: one
// stops a send that had not fired, the other acknowledges one that broke. Read
// the status first and NAME which happened — the claim path above is untouched.
export async function cancelOrDismiss(api, id) {
  const before = await api.db.prepare('SELECT status FROM plugin_gtm_scheduled_sends WHERE id=?').bind(id).first().catch(() => null);
  const r = await cancelScheduled(api, id);
  if (!r.ok) return r;
  return { ...r, action: before?.status === 'scheduled' ? 'cancelled' : 'dismissed' };
}

export async function listScheduled(api, { lead_id = null, include_done = false } = {}) {
  const where = [];
  const binds = [];
  if (lead_id) { where.push('lead_id = ?'); binds.push(lead_id); }
  if (!include_done) where.push(`status IN ('scheduled','claimed','failed','partial')`);
  const r = await api.db.prepare(
    `SELECT * FROM plugin_gtm_scheduled_sends ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY send_at ASC LIMIT 100`,
  ).bind(...binds).all();
  return (r.results || []).map((row) => ({ ...row, bubbles: JSON.parse(row.bubbles || '[]') }));
}

// ── the runner (called from the existing cron ticks) ────────────────────────
export async function runDueScheduled(api) {
  const due = await api.db.prepare(
    `SELECT id FROM plugin_gtm_scheduled_sends WHERE status='scheduled' AND send_at <= ? ORDER BY send_at ASC LIMIT 10`,
  ).bind(now()).all();
  const results = [];
  for (const { id } of due.results || []) {
    // Layer 2: atomic claim. Exactly one runner wins; a lost race is a no-op.
    const token = sid();
    const claim = await api.db.prepare(
      `UPDATE plugin_gtm_scheduled_sends SET status='claimed', claim_token=?, claimed_at=?, updated_at=? WHERE id=? AND status='scheduled'`,
    ).bind(token, now(), now(), id).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue; // someone else claimed — skip, never double

    const row = await api.db.prepare('SELECT * FROM plugin_gtm_scheduled_sends WHERE id=? AND claim_token=?').bind(id, token).first();
    if (!row) continue;
    const msgs = JSON.parse(row.bubbles || '[]');
    let outcome;
    try {
      // Layer 4: the one send path — pacing, per-bubble logging, its own
      // recent-send refusal. Sends are tagged source 'scheduled'
      // (Layer 5: the host wake-up auto-retry skips that source).
      const r = await sendOutreach(api, { lead_id: row.lead_id, bubbles: msgs, source: 'scheduled', source_ref: id });
      if (r.ok) outcome = { status: 'sent', error: null };
      else outcome = { status: typeof r.failed_at === 'number' && r.sent?.length ? 'partial' : 'failed', error: String(r.error || 'send did not complete').slice(0, 500) };
    } catch (e) {
      // Layer 3: fail CLOSED. The row stays terminal ('failed'); it will not
      // be retried by anything automatic, and cannot be re-claimed.
      outcome = { status: 'failed', error: String(e?.message || e).slice(0, 500) };
    }
    await api.db.prepare(
      `UPDATE plugin_gtm_scheduled_sends SET status=?, sent_at=?, error=?, updated_at=? WHERE id=? AND claim_token=?`,
    ).bind(outcome.status, outcome.status === 'sent' || outcome.status === 'partial' ? now() : null, outcome.error, now(), id, token).run();
    await api.log(`scheduled_${outcome.status}`, { id, lead_id: row.lead_id, error: outcome.error });
    results.push({ id, lead_id: row.lead_id, ...outcome });
  }
  return { due: (due.results || []).length, results };
}

// The same tick, counted the way the operator reads it: how many rows this pass
// CLAIMED, how many landed, how many are now terminal. The claim-then-send loop
// above is untouched — this only names its outcome, so the `scheduled-send-tick`
// workflow can report a result without a caller re-deriving it.
export async function runDueSends(api) {
  const r = await runDueScheduled(api);
  const results = r.results || [];
  return {
    due: r.due,
    claimed: results.length,
    sent: results.filter((x) => x.status === 'sent').length,
    partial: results.filter((x) => x.status === 'partial').length,
    failed: results.filter((x) => x.status === 'failed').length,
    results,
  };
}
