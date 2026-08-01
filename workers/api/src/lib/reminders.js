// ─── meeting reminders ───────────────────────────────────────
// WhatsApp self-message N minutes before a calendar meeting, with the
// meeting's context (time, location, attendees, notes, link).
// Config: meeting_reminder_settings (single row, migration 0038) for the four
// fields the Reminders UI edits, plus the `meeting-reminders` knowledge doc for
// every other tunable (timezone, grace, note cap, horizon) — see
// readReminderPolicy for the precedence and why it is split that way.
// Dedup: calendar_events.reminded_at is claimed BEFORE sending, so two
// concurrent checks can't double-send.
// Trigger: piggybacks on the ops UI's 30s GET /api/nyo/pending poll
// (index.js) via waitUntil, so it runs whenever the command center is
// open. com.nyyon.reminders.plist (repo root) covers headless operation.
import { sendText } from './whatsapp.js';
import { logEvent, readKnowledge, writeKnowledge } from './db.js';

const POLICY_SLUG = 'meeting-reminders';

// Everything the reminder pipeline used to hardcode. The knowledge doc
// overrides these; nothing below is a literal at a call site any more.
export const REMINDER_DEFAULTS = Object.freeze({
  lead_minutes: 10,
  kinds: ['meeting'],
  timezone: 'Asia/Jerusalem',
  grace_minutes: 1,     // still remind if we wake up to a meeting that just started
  note_max_chars: 300,
  horizon_hours: 72,    // how far ahead the upcoming-reminders panel looks
});

const LEGACY_GRACE_MS = REMINDER_DEFAULTS.grace_minutes * 60_000;
let lastCheckAt = 0;          // per-isolate throttle; the reminded_at claim is the real guard

export async function getReminderSettings(env) {
  const row = await env.DB.prepare('SELECT * FROM meeting_reminder_settings WHERE id = 1').first();
  return { ...row, chat_id_effective: row?.chat_id || env.WA_TEST_CHAT_ID || null };
}

export async function updateReminderSettings(env, patch = {}) {
  const cur = await getReminderSettings(env);
  const enabled = patch.enabled === undefined ? cur.enabled : (patch.enabled ? 1 : 0);
  const lead = Math.max(1, Math.min(240, Number(patch.lead_minutes ?? cur.lead_minutes) || REMINDER_DEFAULTS.lead_minutes));
  const chatId = patch.chat_id === undefined ? cur.chat_id : (String(patch.chat_id || '').trim() || null);
  const kinds = patch.kinds === undefined ? cur.kinds : (String(patch.kinds || '').trim() || REMINDER_DEFAULTS.kinds.join(','));
  await env.DB.prepare(
    'UPDATE meeting_reminder_settings SET enabled = ?, lead_minutes = ?, chat_id = ?, kinds = ?, updated_at = ? WHERE id = 1',
  ).bind(enabled, lead, chatId, kinds, Date.now()).run();
  await logEvent(env, { kind: 'reminder_settings_updated', actor: 'operator', payload: { enabled: !!enabled, lead_minutes: lead, chat_id: chatId, kinds } });
  return getReminderSettings(env);
}

// ── the editable policy ─────────────────────────────────────────────────────
function coercePolicy(src) {
  const out = { ...REMINDER_DEFAULTS, kinds: [...REMINDER_DEFAULTS.kinds] };
  if (!src || typeof src !== 'object') return out;
  for (const k of ['lead_minutes', 'grace_minutes', 'note_max_chars', 'horizon_hours']) {
    const v = Number(src[k]);
    if (Number.isFinite(v) && v > 0) out[k] = Math.floor(v);
  }
  if (typeof src.timezone === 'string' && src.timezone.trim()) out.timezone = src.timezone.trim();
  const raw = Array.isArray(src.kinds) ? src.kinds : String(src.kinds ?? '').split(',');
  const kinds = raw.map((k) => String(k).trim()).filter(Boolean);
  if (kinds.length) out.kinds = kinds;
  return out;
}

const POLICY_DOC_BODY = (p) => `Meeting reminders · policy.

\`\`\`json
${JSON.stringify(p, null, 2)}
\`\`\`

---
\`lead_minutes\`, \`kinds\`, the target chat and the on/off switch are also edited
in the Reminders panel; whatever the panel last saved wins over this block. The
rest (timezone, grace, note cap, horizon) lives only here.`;

// One policy object for the whole reminder pipeline.
//
// Precedence is deliberate: the settings row owns exactly the four fields the
// Reminders UI writes, so editing the doc can never silently override what the
// operator just clicked; the doc owns everything else and supplies the fallback.
// A missing/corrupt doc degrades to defaults — a reminder must never fail to
// fire because knowledge is unreadable.
export async function readReminderPolicy(env) {
  let parsed = null;
  let source = 'defaults';
  try {
    const doc = await readKnowledge(env, POLICY_SLUG);
    if (doc) {
      const m = String(doc.body || '').match(/```json\s*([\s\S]*?)```/);
      if (m) { try { parsed = JSON.parse(m[1]); source = 'doc'; } catch { /* keep defaults */ } }
    } else {
      // Seed once so the operator has something to edit; a doc that does not
      // exist is a tunable nobody can find.
      await writeKnowledge(env, {
        slug: POLICY_SLUG,
        title: 'Meeting reminders · policy',
        body: POLICY_DOC_BODY(REMINDER_DEFAULTS),
        parent_slug: 'knowledge-root',
      });
    }
  } catch { /* knowledge is advisory here, never a blocker */ }

  const base = coercePolicy(parsed);
  const row = await getReminderSettings(env).catch(() => null);
  const rowKinds = String(row?.kinds || '').split(',').map((k) => k.trim()).filter(Boolean);
  const rowLead = Number(row?.lead_minutes);
  return {
    ...base,
    enabled: row ? !!row.enabled : true,
    lead_minutes: Number.isFinite(rowLead) && rowLead > 0 ? Math.floor(rowLead) : base.lead_minutes,
    kinds: rowKinds.length ? rowKinds : base.kinds,
    chat_id: row?.chat_id_effective || null,
    source,
  };
}

const fmtTime = (ms, timezone = REMINDER_DEFAULTS.timezone) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

export function composeReminder(ev, now = Date.now(), policy = REMINDER_DEFAULTS) {
  const mins = Math.max(0, Math.round((ev.starts_at - now) / 60_000));
  const when = mins === 0 ? 'now' : `in ${mins} min`;
  const lines = [`⏰ ${ev.title} - ${when} (${fmtTime(ev.starts_at, policy.timezone)})`];
  if (ev.location) lines.push(`📍 ${ev.location}`);
  const attendees = safeArr(ev.attendees).map((a) => a?.name || a?.email).filter(Boolean);
  if (attendees.length) lines.push(`👥 ${attendees.join(', ')}`);
  const notes = (ev.description || ev.body || '').trim();
  const cap = Number(policy.note_max_chars) > 0 ? Math.floor(policy.note_max_chars) : REMINDER_DEFAULTS.note_max_chars;
  if (notes) lines.push(notes.length > cap ? notes.slice(0, cap) + '…' : notes);
  if (ev.link_url) lines.push(ev.link_url);
  return lines.join('\n');
}

function safeArr(v) {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}

// Next candidate meetings with the computed fire time, for the UI panel + Nyo.
export async function upcomingReminders(env, { hours = null } = {}) {
  const p = await readReminderPolicy(env);
  const horizon = Number(hours) > 0 ? Number(hours) : p.horizon_hours;
  const now = Date.now();
  const r = await env.DB.prepare(
    `SELECT id, kind, title, starts_at, status, all_day, location, reminded_at
       FROM calendar_events
      WHERE starts_at > ? AND starts_at <= ?
        AND kind IN (${p.kinds.map(() => '?').join(',')})
      ORDER BY starts_at ASC LIMIT 30`,
  ).bind(now - p.grace_minutes * 60_000, now + horizon * 3_600_000, ...p.kinds).all();
  const events = (r.results || []).map((ev) => ({
    ...ev,
    will_remind: p.enabled && !ev.all_day && !ev.reminded_at && ['pending', 'confirmed'].includes(ev.status),
    remind_at: ev.starts_at - p.lead_minutes * 60_000,
  }));
  // The panel still renders the raw settings row, so hand it back unchanged.
  return { settings: await getReminderSettings(env), events };
}

// ── the three granular steps the meeting-reminders workflow runs ────────────

// Step 1. Unreminded meetings inside the lead window. Read-only: nothing is
// claimed here, so calling this to decide whether the workflow is worth running
// has no side effects.
export async function listDueMeetings(env, { hours = null } = {}) {
  const p = await readReminderPolicy(env);
  const base = { due_meetings: [], chatId: p.chat_id, lead_minutes: p.lead_minutes, timezone: p.timezone };
  if (!p.enabled) return { ...base, skipped: 'disabled' };
  if (!p.chat_id) return { ...base, skipped: 'no chat_id configured (set one in Reminders, or define WA_TEST_CHAT_ID)' };

  const now = Date.now();
  const windowMs = Number(hours) > 0 ? Number(hours) * 3_600_000 : p.lead_minutes * 60_000;
  const r = await env.DB.prepare(
    `SELECT * FROM calendar_events
      WHERE reminded_at IS NULL AND all_day = 0
        AND status IN ('pending', 'confirmed')
        AND kind IN (${p.kinds.map(() => '?').join(',')})
        AND starts_at > ? AND starts_at <= ?
      ORDER BY starts_at ASC`,
  ).bind(...p.kinds, now - p.grace_minutes * 60_000, now + windowMs).all();
  return { ...base, due_meetings: r.results || [] };
}

// Step 2 ⚙️. The at-most-once guarantee, and the reason the loop lives inside
// ONE tool: each row is claimed with a single atomic
// `UPDATE … WHERE reminded_at IS NULL`, and only the rows THIS call won are
// handed to the send step. A concurrent run finds them already claimed and
// drops them, so the same reminder can never go out twice.
// The claim is NOT released when a send later fails — fail closed, no auto
// retry. A missed reminder is visible in workflow_runs; a duplicate one at
// 08:59 is not recoverable.
export async function claimDueMeetings(env, meetings = []) {
  const claimed_at = Date.now();
  const claimed = [];
  for (const ev of Array.isArray(meetings) ? meetings : []) {
    if (!ev?.id) continue;
    const res = await env.DB.prepare(
      'UPDATE calendar_events SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL',
    ).bind(claimed_at, ev.id).run();
    if (res.meta?.changes) claimed.push(ev);
  }
  if (claimed.length) {
    await logEvent(env, {
      kind: 'meeting_reminders_claimed',
      actor: 'system',
      payload: { claimed_at, ids: claimed.map((e) => e.id) },
    });
  }
  return { claimed_meetings: claimed, claimed_at, dropped: (meetings?.length || 0) - claimed.length };
}

// Step 3. One message for everything claimed, so three back-to-back meetings
// arrive as one buzz rather than three.
export async function composeReminderDigest(env, { claimed_meetings = [], chatId = null } = {}) {
  const p = await readReminderPolicy(env);
  const to = chatId || p.chat_id;
  const rows = Array.isArray(claimed_meetings) ? claimed_meetings : [];
  if (!rows.length) return { chatId: to, text: null, count: 0 };
  const now = Date.now();
  return { chatId: to, text: rows.map((ev) => composeReminder(ev, now, p)).join('\n\n'), count: rows.length };
}

// ── legacy fat path ─────────────────────────────────────────────────────────
// Superseded by the meeting-reminders workflow (list → claim → compose → send).
// Still exported because index.js's poll and cron call it; retire both together.
// Note this version RELEASES the claim on a failed send (auto-retry), which the
// workflow deliberately does not.
export async function checkMeetingReminders(env, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastCheckAt < 60_000) return { skipped: 'throttled' };
  lastCheckAt = now;

  const s = await getReminderSettings(env);
  if (!s.enabled) return { skipped: 'disabled' };
  if (!s.chat_id_effective) return { skipped: 'no chat_id configured (set one or define WA_TEST_CHAT_ID)' };

  const kinds = s.kinds.split(',').map((k) => k.trim()).filter(Boolean);
  const r = await env.DB.prepare(
    `SELECT * FROM calendar_events
      WHERE reminded_at IS NULL AND all_day = 0
        AND status IN ('pending', 'confirmed')
        AND kind IN (${kinds.map(() => '?').join(',')})
        AND starts_at > ? AND starts_at <= ?`,
  ).bind(...kinds, now - LEGACY_GRACE_MS, now + s.lead_minutes * 60_000).all();

  const sent = [], failed = [];
  for (const ev of r.results || []) {
    // Claim before sending so a concurrent check can't double-send.
    const claim = await env.DB.prepare(
      'UPDATE calendar_events SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL',
    ).bind(now, ev.id).run();
    if (!claim.meta?.changes) continue;
    const text = composeReminder(ev, now);
    try {
      await sendText(env, { chatId: s.chat_id_effective, text }, { source: 'meeting-reminder' });
      sent.push({ id: ev.id, title: ev.title });
      await logEvent(env, { kind: 'meeting_reminder_sent', actor: 'system', payload: { event_id: ev.id, title: ev.title, starts_at: ev.starts_at, chat_id: s.chat_id_effective } });
    } catch (e) {
      // Release the claim so the next poll retries; log so it shows in Activity.
      await env.DB.prepare('UPDATE calendar_events SET reminded_at = NULL WHERE id = ?').bind(ev.id).run();
      failed.push({ id: ev.id, title: ev.title, error: String(e?.message || e) });
      await logEvent(env, { kind: 'meeting_reminder_failed', actor: 'system', payload: { event_id: ev.id, title: ev.title, error: String(e?.message || e) } });
    }
  }
  return { checked: (r.results || []).length, sent, failed };
}
