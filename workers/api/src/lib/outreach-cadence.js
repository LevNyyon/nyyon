// Outreach · cadence — the editable rules for the automated queue, and for
// when a conversation counts as dead.
//
// Its own module on purpose: both the conversation list (outreach-wa.js) and
// the queue engine (outreach-cohorts.js) need these numbers, and having either
// import the other would be a cycle. Nothing here reasons or sends — it reads
// one knowledge doc and hands back plain numbers, seeding the doc on first read.

import { readKnowledge, writeKnowledge, logEvent } from './db.js';

const SLUG = 'outreach-cohort-cadence';

// Defaults are deliberately conservative: follow-ups spread over two weeks,
// a small daily ceiling, and business hours only. The doc overrides all of it.
export const CADENCE_DEFAULTS = {
  // hours to wait before each FOLLOW-UP (step 0 is the first touch and goes as
  // soon as it is due). Fewer entries than bubbles → the last value repeats.
  step_delays_hours: [72, 96, 168],
  max_sends_per_day: 20,
  min_gap_minutes: 8,
  quiet_start_hour: 9,   // sends allowed from this hour…
  quiet_end_hour: 19,    // …until this one, operator local time
  weekdays_only: true,
  timezone: 'Asia/Jerusalem',
  dead_after_days: 21,
  // Every individual message waits for the operator to approve it, rather than
  // go-live approving a person's whole ladder in one press. Defaults ON: the
  // safe direction for a mistake here is "nothing sent", never "sent unread".
  require_approval: true,
  // Ceiling on a message the operator writes by hand in the cohort sheet.
  max_message_chars: 4000,
};

const NUMERIC = ['max_sends_per_day', 'min_gap_minutes', 'quiet_start_hour', 'quiet_end_hour', 'dead_after_days', 'max_message_chars'];

function coerce(src) {
  const out = { ...CADENCE_DEFAULTS };
  if (!src || typeof src !== 'object') return out;
  for (const k of NUMERIC) {
    const v = Number(src[k]);
    if (Number.isFinite(v) && v >= 0) out[k] = Math.floor(v);
  }
  if (Array.isArray(src.step_delays_hours)) {
    const arr = src.step_delays_hours.map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    if (arr.length) out.step_delays_hours = arr;
  }
  if (typeof src.weekdays_only === 'boolean') out.weekdays_only = src.weekdays_only;
  if (typeof src.require_approval === 'boolean') out.require_approval = src.require_approval;
  if (typeof src.timezone === 'string' && src.timezone.trim()) out.timezone = src.timezone.trim();
  // A window that cannot open would silently freeze the queue forever — treat
  // it as unset rather than letting it look like "nothing is due".
  if (out.quiet_end_hour <= out.quiet_start_hour) {
    out.quiet_start_hour = CADENCE_DEFAULTS.quiet_start_hour;
    out.quiet_end_hour = CADENCE_DEFAULTS.quiet_end_hour;
  }
  return out;
}

// Read the cadence, seeding the doc on first read. Never throws.
export async function loadCohortCadence(env) {
  try {
    const doc = await readKnowledge(env, SLUG);
    if (!doc) return { cadence: { ...CADENCE_DEFAULTS }, source: 'defaults', notes: '' };
    const body = String(doc.body || '');
    const m = body.match(/```json\s*([\s\S]*?)```/);
    let parsed = null;
    if (m) { try { parsed = JSON.parse(m[1]); } catch { parsed = null; } }
    const idx = body.indexOf('\n---\n');
    return {
      cadence: coerce(parsed),
      source: parsed ? 'doc' : 'defaults',
      notes: (idx >= 0 ? body.slice(idx + 5) : '').trim(),
    };
  } catch {
    return { cadence: { ...CADENCE_DEFAULTS }, source: 'defaults', notes: '' };
  }
}

// Merge a patch into the doc's json block, leaving the prose untouched.
export async function saveCohortCadence(env, patch = {}) {
  const cur = await loadCohortCadence(env);
  const next = coerce({ ...cur.cadence, ...patch });
  const doc = await readKnowledge(env, SLUG).catch(() => null);
  const body = String(doc?.body || '');
  const json = JSON.stringify(next, null, 2);
  const nextBody = body.match(/```json\s*([\s\S]*?)```/)
    ? body.replace(/```json\s*[\s\S]*?```/, '```json\n' + json + '\n```')
    : `Outreach · Queue cadence.\n\n\`\`\`json\n${json}\n\`\`\`\n\n---\n${cur.notes}`;
  await writeKnowledge(env, {
    slug: SLUG, title: 'Outreach · Queue cadence', body: nextBody, parent_slug: 'module-outreach',
  });
  await logEvent(env, { kind: 'outreach_cadence_updated', payload: next });
  return { cadence: next, source: 'doc' };
}

// ── the sending window ──────────────────────────────────────────────────────
// Hour-of-day + weekday in the configured zone. Intl does the DST work; a bad
// zone string falls back to UTC rather than throwing inside the cron.
export function zonedParts(at, timezone) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false, weekday: 'short',
    }).formatToParts(new Date(at));
    const hour = Number(p.find((x) => x.type === 'hour')?.value ?? 0);
    const wd = p.find((x) => x.type === 'weekday')?.value || '';
    return { hour: hour === 24 ? 0 : hour, weekday: wd, weekend: wd === 'Sat' || wd === 'Sun' };
  } catch {
    const d = new Date(at);
    return { hour: d.getUTCHours(), weekday: '', weekend: [0, 6].includes(d.getUTCDay()) };
  }
}

// ── naming a moment in the zone it will actually happen in ──────────────────
// The sheet has to say WHEN a message goes out, and a bare clock time is a lie
// unless it carries the zone: 09:00 means two different moments to a cohort set
// to Asia/Jerusalem and an operator reading in New York. The server names the
// moment — including the short zone tag and which calendar day it lands on —
// so the browser never re-derives it and the two can never disagree.
export function zonedLabel(at, timezone) {
  if (!at) return null;
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZoneName: 'short', day: '2-digit', month: 'short',
    }).formatToParts(new Date(at));
    const get = (t) => p.find((x) => x.type === t)?.value || '';
    return {
      label: `${get('weekday')} ${get('day')} ${get('month')} ${get('hour')}:${get('minute')}`,
      zone: get('timeZoneName'),
      ymd: zonedYmd(at, timezone),
    };
  } catch {
    return { label: new Date(at).toISOString().slice(0, 16).replace('T', ' '), zone: 'UTC', ymd: new Date(at).toISOString().slice(0, 10) };
  }
}

// The calendar day `at` falls on in `timezone`. "Scheduled today" is a question
// about the cohort's day, not the server's UTC day or the browser's.
export function zonedYmd(at, timezone) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(at));
    const get = (t) => p.find((x) => x.type === t)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

// ── per-weekday sending windows ─────────────────────────────────────────────
// `{"1":{"start":"09:00","end":"17:30"}}` — 0 = Sunday. An absent day sends
// nothing. Times are wall-clock in the cohort's zone, to the minute.
export function parseWindows(raw) {
  let src = raw;
  if (typeof raw === 'string') { try { src = JSON.parse(raw); } catch { return null; } }
  if (!src || typeof src !== 'object') return null;
  const hm = (v) => {
    const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]); const mi = Number(m[2]);
    if (h < 0 || h > 24 || mi < 0 || mi > 59) return null;
    return h * 60 + mi;
  };
  const out = {};
  for (let d = 0; d <= 6; d++) {
    const w = src[d] ?? src[String(d)];
    if (!w) continue;
    const s = hm(w.start); const e = hm(w.end);
    // A window that cannot open is worse than no window: it looks configured
    // and sends nothing. Drop the day instead of storing an impossible one.
    if (s === null || e === null || e <= s) continue;
    out[d] = { start: w.start, end: w.end, s, e };
  }
  return Object.keys(out).length ? out : null;
}

// Epoch for a wall-clock moment in `timezone`. Fixed-point iteration so DST
// changeovers land on the real instant rather than an hour out — the same
// approach the browser-side picker uses, so the two agree.
export function epochForWall(timezone, y, mo, d, hh, mi) {
  let guess = Date.UTC(y, mo - 1, d, hh, mi);
  for (let i = 0; i < 4; i++) {
    let p;
    try {
      p = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(guess));
    } catch { return guess; }
    const g = (t) => Number(p.find((x) => x.type === t)?.value ?? 0);
    const diff = Date.UTC(y, mo - 1, d, hh, mi) - Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
    if (!diff) break;
    guess += diff;
  }
  return guess;
}

// Calendar date + weekday of `at` in `timezone`.
function zonedDate(at, timezone) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(new Date(at));
    const g = (t) => p.find((x) => x.type === t)?.value || '';
    return { y: Number(g('year')), mo: Number(g('month')), d: Number(g('day')), wd: WEEKDAY_INDEX[g('weekday')] ?? 0 };
  } catch {
    const dt = new Date(at);
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), wd: dt.getUTCDay() };
  }
}

// A cohort's own window layered over the account default. Anything the cohort
// leaves unset simply inherits, so an untouched cohort behaves exactly as it
// did before cohorts could carry a window at all.
export function effectiveCadence(cadence, cohort) {
  if (!cohort) return cadence;
  const out = { ...cadence };
  if (cohort.timezone) out.timezone = cohort.timezone;
  const s = Number(cohort.start_hour);
  const e = Number(cohort.end_hour);
  if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
    out.quiet_start_hour = Math.floor(s);
    out.quiet_end_hour = Math.floor(e);
  }
  let days = null;
  try { days = cohort.send_days ? JSON.parse(cohort.send_days) : null; } catch { days = null; }
  // An explicit day list beats the coarse weekdays_only flag. An EMPTY list
  // would mean "never" — treat it as unset rather than silently freezing the
  // cohort forever.
  if (Array.isArray(days) && days.length) {
    out.send_days = days.map(Number).filter((d) => d >= 0 && d <= 6);
  }
  // Per-weekday windows, if the cohort has them, OVERRIDE both the single
  // start/end pair and the day list — they say the same things with more
  // precision, so letting the coarse pair apply as well could only contradict.
  const win = parseWindows(cohort.send_windows);
  if (win) out.send_windows = win;
  return out;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Hour AND minute in the zone. zonedParts reports the hour alone, which was
// enough while windows were whole hours and is not any more.
function zonedClock(at, timezone) {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const g = (t) => Number(p.find((x) => x.type === t)?.value ?? 0);
    return { hour: g('hour') % 24, minute: g('minute') };
  } catch {
    const d = new Date(at);
    return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
}

// Is `at` inside the allowed sending window?
export function withinWindow(at, cadence) {
  // Per-weekday windows win when present: a day that is absent sends nothing,
  // and the comparison is to the minute rather than the hour.
  if (cadence.send_windows) {
    const { wd } = zonedDate(at, cadence.timezone);
    const w = cadence.send_windows[wd];
    if (!w) return false;
    const { hour, minute } = zonedClock(at, cadence.timezone);
    const mins = hour * 60 + minute;
    return mins >= w.s && mins < w.e;
  }
  const { hour, weekend, weekday } = zonedParts(at, cadence.timezone);
  if (Array.isArray(cadence.send_days) && cadence.send_days.length) {
    const idx = WEEKDAY_INDEX[weekday];
    if (idx === undefined || !cadence.send_days.includes(idx)) return false;
  } else if (cadence.weekdays_only && weekend) {
    return false;
  }
  return hour >= cadence.quiet_start_hour && hour < cadence.quiet_end_hour;
}

// The next moment sending is allowed at or after `at`.
//
// With per-day windows this COMPUTES the opening rather than walking forward:
// stepping in whole hours would stride straight over a 09:30 start and land at
// 10:00, quietly making every window half an hour shorter than it reads.
export function nextWindowOpening(at, cadence) {
  if (cadence.send_windows) {
    const tz = cadence.timezone;
    for (let i = 0; i < 14; i++) {
      const probe = at + i * 86400000;
      const { y, mo, d, wd } = zonedDate(probe, tz);
      const w = cadence.send_windows[wd];
      if (!w) continue;
      const open = epochForWall(tz, y, mo, d, Math.floor(w.s / 60), w.s % 60);
      const shut = epochForWall(tz, y, mo, d, Math.floor(w.e / 60), w.e % 60);
      if (at <= open) return open;      // window still to come today
      if (at < shut) return at;         // already inside it
    }
    return at;                          // nothing open in a fortnight — say so by not moving
  }
  let t = at;
  for (let i = 0; i < 24 * 14; i++) {
    if (withinWindow(t, cadence)) return t;
    t += 3600000;
  }
  return at;
}
