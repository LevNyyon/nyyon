// GTM scheduled sends — schedule outreach bubbles for a future time, with the
// no-duplicate guarantee as the design center. Five independent layers, any
// one of which blocks a dup:
//
//   1. SCHEDULE-time: a DB partial-unique index rejects a second live schedule
//      of the same content for the same lead; identical content EVER sent to
//      this lead (gtm_sends history) is refused outright.
//   2. CLAIM-time: the runner claims a due row with an atomic conditional
//      UPDATE — concurrent runners cannot both win.
//   3. FAIL-CLOSED: once claimed, a row never re-arms itself. A crash between
//      claim and confirmation leaves it 'claimed' — surfaced to the operator,
//      never auto-retried. A missed send beats a duplicate, always.
//   4. SEND-time: delivery goes through the ONE existing sendOutreach path,
//      which carries its own recent-send refusal + per-bubble gtm_sends log.
//   5. NO AUTO-RETRY: outbox rows are stamped source='scheduled', which the
//      wake-up auto-retry explicitly skips.
//
// Config (max horizon) is knowledge-backed: gtm-schedule doc, json fence.

import { logEvent, readKnowledge, writeKnowledge } from './db.js';
import { getLead } from './gtm.js';
import { toChatId, ensureListening } from './whatsapp.js';
import { sendOutreach } from './gtm-outreach.js';

const now = () => Date.now();
const sid = () => `ss_${now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Normalized content hash — same text modulo whitespace = same content.
export function contentHash(bubbles) {
  const norm = (bubbles || []).map((b) => String(b || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('');
  // djb2 — stable, dependency-free; collisions are backstopped by layer 4.
  let h = 5381;
  for (let i = 0; i < norm.length; i++) h = ((h << 5) + h + norm.charCodeAt(i)) >>> 0;
  return `${h.toString(36)}_${norm.length}`;
}

const CONFIG_SLUG = 'gtm-schedule';
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

export async function scheduleConfig(env) { return config(env); }

async function config(env) {
  try {
    const doc = await readKnowledge(env, CONFIG_SLUG);
    if (!doc) {
      await writeKnowledge(env, { slug: CONFIG_SLUG, title: 'GTM · scheduled sends', body: CONFIG_SEED, parent_slug: 'module-gtm' }).catch(() => {});
      return { ...CONFIG_DEFAULTS };
    }
    const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
    return { ...CONFIG_DEFAULTS, ...(m ? JSON.parse(m[1]) : {}) };
  } catch { return { ...CONFIG_DEFAULTS }; }
}

// ── schedule ────────────────────────────────────────────────────────────────
export async function scheduleSend(env, { lead_id, bubbles, send_at }) {
  const lead = await getLead(env, lead_id);
  if (!lead) return { error: 'no lead' };
  const msgs = (bubbles || []).map((b) => String(b || '').trim()).filter(Boolean);
  if (!msgs.length) return { error: 'no bubbles to schedule' };
  if (msgs.length > 4) return { error: 'more than 4 bubbles — the playbook caps a touch at 4' };
  const at = Number(send_at);
  if (!Number.isFinite(at) || at < now() - 60 * 1000) return { error: 'send_at must be a future time (ms epoch)' };
  const cfg = await config(env);
  if (at > now() + cfg.max_horizon_days * 86400 * 1000) return { error: `send_at is beyond the ${cfg.max_horizon_days}-day horizon` };

  let chatId;
  try { chatId = toChatId(lead.normalized_phone || lead.phone); }
  catch { return { error: 'lead has no usable phone' }; }

  await ensureListening(env, chatId).catch(() => {});
  const hash = contentHash(msgs);
  // Layer 1b: identical content already DELIVERED to this lead, ever → refuse.
  // (Change the text if a deliberate re-send is wanted; there is no force here.)
  const prior = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM gtm_sends WHERE lead_id = ? AND status = 'sent' AND bubble IN (${msgs.map(() => '?').join(',')})`,
  ).bind(lead_id, ...msgs).first();
  if ((prior?.n ?? 0) > 0) {
    return { error: 'refused: one or more of these exact bubbles was ALREADY SENT to this lead. Scheduling identical content again is blocked — edit the text if a deliberate repeat is intended.' };
  }

  const id = sid();
  try {
    await env.DB.prepare(
      `INSERT INTO scheduled_sends (id, lead_id, chat_id, bubbles, content_hash, send_at, status, created_at, updated_at)
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
  await logEvent(env, { kind: 'gtm_send_scheduled', actor: 'operator', payload: { id, lead_id, send_at: at, bubbles: msgs.length } });
  return { ok: true, id, lead_id, send_at: at, bubbles: msgs, note: 'fires on the first cron tick at or after send_at (up to ~40 min late, never early, never twice)' };
}

export async function cancelScheduled(env, id) {
  // Atomic. A 'scheduled' row is cancelled before it fires; a terminal
  // 'failed'/'partial' row is dismissed (acknowledged) the same way. A
  // claimed row is in flight (or fail-closed) and cannot be un-fired.
  const r = await env.DB.prepare(
    `UPDATE scheduled_sends SET status='cancelled', updated_at=? WHERE id=? AND status IN ('scheduled','failed','partial')`,
  ).bind(now(), id).run();
  const ok = (r.meta?.changes ?? 0) === 1;
  if (ok) await logEvent(env, { kind: 'gtm_schedule_cancelled', actor: 'operator', payload: { id } });
  else {
    const row = await env.DB.prepare('SELECT status FROM scheduled_sends WHERE id=?').bind(id).first();
    return { ok: false, error: row ? `cannot cancel: schedule is '${row.status}'` : 'schedule not found' };
  }
  return { ok: true, id };
}

// Cancelling a live schedule and dismissing a terminal failed/partial one are
// the same atomic UPDATE, but they are not the same thing to the operator: one
// stops a send that had not fired, the other acknowledges one that broke. Read
// the status first and NAME which happened — the claim path above is untouched.
export async function cancelOrDismiss(env, id) {
  const before = await env.DB.prepare('SELECT status FROM scheduled_sends WHERE id=?').bind(id).first().catch(() => null);
  const r = await cancelScheduled(env, id);
  if (!r.ok) return r;
  return { ...r, action: before?.status === 'scheduled' ? 'cancelled' : 'dismissed' };
}

export async function listScheduled(env, { lead_id = null, include_done = false } = {}) {
  const where = [];
  const binds = [];
  if (lead_id) { where.push('lead_id = ?'); binds.push(lead_id); }
  if (!include_done) where.push(`status IN ('scheduled','claimed','failed','partial')`);
  const r = await env.DB.prepare(
    `SELECT * FROM scheduled_sends ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY send_at ASC LIMIT 100`,
  ).bind(...binds).all();
  return (r.results || []).map((row) => ({ ...row, bubbles: JSON.parse(row.bubbles || '[]') }));
}

// ── the runner (called from the existing cron ticks) ────────────────────────
export async function runDueScheduled(env) {
  const due = await env.DB.prepare(
    `SELECT id FROM scheduled_sends WHERE status='scheduled' AND send_at <= ? ORDER BY send_at ASC LIMIT 10`,
  ).bind(now()).all();
  const results = [];
  for (const { id } of due.results || []) {
    // Layer 2: atomic claim. Exactly one runner wins; a lost race is a no-op.
    const token = sid();
    const claim = await env.DB.prepare(
      `UPDATE scheduled_sends SET status='claimed', claim_token=?, claimed_at=?, updated_at=? WHERE id=? AND status='scheduled'`,
    ).bind(token, now(), now(), id).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue; // someone else claimed — skip, never double

    const row = await env.DB.prepare('SELECT * FROM scheduled_sends WHERE id=? AND claim_token=?').bind(id, token).first();
    if (!row) continue;
    const msgs = JSON.parse(row.bubbles || '[]');
    let outcome;
    try {
      // Layer 4: the one send path — pacing, per-bubble logging, its own
      // recent-send refusal. outbox rows are stamped source 'scheduled'
      // (Layer 5: wake-up auto-retry skips that source).
      const r = await sendOutreach(env, { lead_id: row.lead_id, bubbles: msgs, source: 'scheduled', source_ref: id });
      if (r.ok) outcome = { status: 'sent', error: null };
      else outcome = { status: typeof r.failed_at === 'number' && r.sent?.length ? 'partial' : 'failed', error: String(r.error || 'send did not complete').slice(0, 500) };
    } catch (e) {
      // Layer 3: fail CLOSED. The row stays terminal ('failed'); it will not
      // be retried by anything automatic, and cannot be re-claimed.
      outcome = { status: 'failed', error: String(e?.message || e).slice(0, 500) };
    }
    await env.DB.prepare(
      `UPDATE scheduled_sends SET status=?, sent_at=?, error=?, updated_at=? WHERE id=? AND claim_token=?`,
    ).bind(outcome.status, outcome.status === 'sent' || outcome.status === 'partial' ? now() : null, outcome.error, now(), id, token).run();
    await logEvent(env, { kind: `gtm_scheduled_${outcome.status}`, actor: 'system', payload: { id, lead_id: row.lead_id, error: outcome.error } });
    results.push({ id, lead_id: row.lead_id, ...outcome });
  }
  return { due: (due.results || []).length, results };
}

// The same tick, counted the way the operator reads it: how many rows this pass
// CLAIMED, how many landed, how many are now terminal. The claim-then-send loop
// above is untouched — this only names its outcome, so the `scheduled-send-tick`
// workflow can report a result without a caller re-deriving it.
export async function runDueSends(env) {
  const r = await runDueScheduled(env);
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
